import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  overrideAdapterExecutionTargetRemoteCwd,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  materializePaperclipSkillCopy,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  readPaperclipRuntimeSkillEntries,
  refreshPaperclipWorkspaceEnvForExecution,
  renderPaperclipWakePrompt,
  renderTemplate,
  resolvePaperclipDesiredSkillNames,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import {
  detectNewConversationId,
  parseBrainListing,
  resolveAntigravityBrainDir,
  snapshotConversationIds,
  REMOTE_BRAIN_LS_DIR,
} from "./brain.js";
import { isAntigravityUnknownSessionError, parseAntigravityOutput } from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const ADAPTER_TYPE = "antigravity_local";
const DEFAULT_COMMAND = "agy";
const DEFAULT_PRINT_TIMEOUT_SEC = 600;

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function renderPaperclipEnvNote(env: Record<string, string>): string {
  const paperclipKeys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  if (paperclipKeys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${paperclipKeys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
    "",
    "",
  ].join("\n");
}

function renderApiAccessNote(env: Record<string, string>): string {
  if (!hasNonEmptyEnvValue(env, "PAPERCLIP_API_URL") || !hasNonEmptyEnvValue(env, "PAPERCLIP_API_KEY")) return "";
  return [
    "Paperclip API access note:",
    "Use shell commands with curl to make Paperclip API requests when needed.",
    "Include X-Paperclip-Run-Id on mutating requests.",
    "",
    "",
  ].join("\n");
}

async function readInstructionsSection(instructionsFilePath: string): Promise<string> {
  if (!instructionsFilePath) return "";
  const contents = await fs.readFile(instructionsFilePath, "utf8").catch(() => "");
  const trimmed = contents.trim();
  if (!trimmed) return "";
  return ["# Agent instructions", "", trimmed, "", ""].join("\n");
}

type StageCleanup = { kind: "file" | "dir"; path: string };

interface StagedAssets {
  cleanup: () => Promise<void>;
  stagedSkillsCount: number;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

/**
 * Stage the desired Paperclip skills into the execution workspace at
 * `.agents/skills/<skill>` so Antigravity discovers them as project skills
 * (the workspace skills path moved from `.gemini/skills` to `.agents/skills`
 * in the 2026-06 Antigravity CLI migration). Staging into the workspace cwd
 * (rather than a local tmpdir) means the skills are included when the
 * workspace is synced to a remote SSH target. The staged entries are removed
 * in cleanup so the project checkout is left clean.
 */
async function stageAntigravityProjectAssets(input: {
  cwd: string;
  skillEntries: Array<{ key: string; runtimeName: string; source: string }>;
  desiredSkillNames: string[];
  onLog: AdapterExecutionContext["onLog"];
}): Promise<StagedAssets> {
  const cleanup: StageCleanup[] = [];
  let stagedSkillsCount = 0;

  const desiredSet = new Set(input.desiredSkillNames);
  const selected = input.skillEntries.filter((entry) => desiredSet.has(entry.key));
  if (selected.length > 0) {
    const agentsDir = path.join(input.cwd, ".agents");
    const skillsRoot = path.join(agentsDir, "skills");
    if (!(await pathExists(agentsDir))) cleanup.push({ kind: "dir", path: agentsDir });
    else if (!(await pathExists(skillsRoot))) cleanup.push({ kind: "dir", path: skillsRoot });
    await fs.mkdir(skillsRoot, { recursive: true });

    for (const skill of selected) {
      const target = path.join(skillsRoot, skill.runtimeName);
      if (await pathExists(target)) {
        await input.onLog(
          "stdout",
          `[paperclip] Antigravity skill target already exists at ${target}; leaving it unchanged.\n`,
        );
        continue;
      }
      try {
        await materializePaperclipSkillCopy(skill.source, target);
        cleanup.push({ kind: "dir", path: target });
        stagedSkillsCount += 1;
      } catch (err) {
        await input.onLog(
          "stdout",
          `[paperclip] Failed to stage Antigravity skill "${skill.runtimeName}": ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
  }

  return {
    stagedSkillsCount,
    cleanup: async () => {
      for (const entry of [...cleanup].reverse()) {
        if (entry.kind === "file") {
          await fs.rm(entry.path, { force: true }).catch(() => undefined);
          continue;
        }
        await fs.rm(entry.path, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const command = asString(config.command, DEFAULT_COMMAND).trim() || DEFAULT_COMMAND;
  const model = asString(config.model, "").trim();
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const sandbox = asBoolean(config.sandbox, false);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const skillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = resolvePaperclipDesiredSkillNames(config, skillEntries);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const stagedAssets = await stageAntigravityProjectAssets({
    cwd,
    skillEntries,
    desiredSkillNames,
    onLog,
  });
  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
  let remoteRuntimeRootDir: string | null = null;
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

  try {
    const envConfig = parseObject(config.env);
    const hasExplicitApiKey =
      typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
    const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
    env.PAPERCLIP_RUN_ID = runId;

    const wakeTaskId =
      (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
      (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
      null;
    const wakeReason =
      typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
        ? context.wakeReason.trim()
        : null;
    const wakeCommentId =
      (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
      (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
      null;
    const approvalId =
      typeof context.approvalId === "string" && context.approvalId.trim().length > 0
        ? context.approvalId.trim()
        : null;
    const approvalStatus =
      typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
        ? context.approvalStatus.trim()
        : null;
    const linkedIssueIds = Array.isArray(context.issueIds)
      ? context.issueIds.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
    const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
    if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
    if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
    if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
    if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
    if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
    if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
    if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
    if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
    refreshPaperclipWorkspaceEnvForExecution({
      env,
      envConfig,
      workspaceCwd: effectiveWorkspaceCwd,
      workspaceSource,
      workspaceId,
      workspaceRepoUrl,
      workspaceRepoRef,
      workspaceHints,
      agentHome,
      executionTargetIsRemote,
      executionCwd: effectiveExecutionCwd,
    });
    for (const [key, value] of Object.entries(envConfig)) {
      if (typeof value === "string") env[key] = value;
    }
    if (!hasExplicitApiKey && authToken) {
      env.PAPERCLIP_API_KEY = authToken;
    }

    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
      executionTarget,
      asNumber(config.timeoutSec, 0),
    );
    const graceSec = asNumber(config.graceSec, 20);
    const printTimeoutSec = (() => {
      const configured = asNumber(config.printTimeoutSec, 0);
      if (configured > 0) return configured;
      if (timeoutSec > 0) return timeoutSec;
      return DEFAULT_PRINT_TIMEOUT_SEC;
    })();

    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog,
    });

    if (executionTargetIsRemote) {
      await onLog(
        "stdout",
        `[paperclip] Syncing Antigravity workspace to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "antigravity",
        workspaceLocalDir: cwd,
        timeoutSec,
        installCommand: ctx.runtimeCommandSpec?.installCommand ?? null,
        detectCommand: ctx.runtimeCommandSpec?.detectCommand ?? command,
      });
      restoreRemoteWorkspace = () => preparedExecutionTargetRuntime.restoreWorkspace();
      effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
      remoteRuntimeRootDir = preparedExecutionTargetRuntime.runtimeRootDir ?? null;
      refreshPaperclipWorkspaceEnvForExecution({
        env,
        envConfig,
        workspaceCwd: effectiveWorkspaceCwd,
        workspaceSource,
        workspaceId,
        workspaceRepoUrl,
        workspaceRepoRef,
        workspaceHints,
        agentHome,
        executionTargetIsRemote,
        executionCwd: effectiveExecutionCwd,
      });
    }

    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    // On remote targets PAPERCLIP_API_URL points at the server's loopback,
    // which is unreachable from the target host. The bridge reverse-tunnels
    // the API to the remote and rewrites the env to the tunneled endpoint —
    // without it, the agent grinds against a dead API and can never post
    // comments or update issues.
    if (executionTargetIsRemote) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        runtimeRootDir: remoteRuntimeRootDir,
        adapterKey: "antigravity",
        timeoutSec,
        hostApiToken: env.PAPERCLIP_API_KEY,
        onLog,
      });
      if (paperclipBridge) {
        Object.assign(env, paperclipBridge.env);
      }
    }
    const effectiveEnv = Object.fromEntries(
      Object.entries({ ...process.env, ...env }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const runtimeEnv = ensurePathInEnv(effectiveEnv) as Record<string, string>;
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
      installCommand: ctx.runtimeCommandSpec?.installCommand ?? null,
      timeoutSec,
    });
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
    const loggedEnv = buildInvocationEnvForLogs(env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME", "USERPROFILE"],
      resolvedCommand,
    });

    // Resolve a resumable conversation, honouring cwd and remote identity.
    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const canResumeSession =
      runtimeSessionId.length > 0 &&
      (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
      adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
    const sessionId = canResumeSession ? runtimeSessionId : null;
    if (executionTargetIsRemote && runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] Antigravity conversation "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed. Starting fresh.\n`,
      );
    } else if (runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] Antigravity conversation "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
      );
    }

    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
    const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
    const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const instructionsSection = await readInstructionsSection(instructionsFilePath);
    const paperclipEnvNote = renderPaperclipEnvNote(env);
    const apiAccessNote = renderApiAccessNote(env);
    const prompt = joinPromptSections([
      wakePrompt,
      sessionHandoffNote,
      instructionsSection,
      paperclipEnvNote,
      apiAccessNote,
      renderedPrompt,
    ]);
    const promptMetrics = {
      promptChars: prompt.length,
      wakePromptChars: wakePrompt.length,
      sessionHandoffChars: sessionHandoffNote.length,
      instructionsChars: instructionsSection.length,
      runtimeNoteChars: paperclipEnvNote.length + apiAccessNote.length,
      heartbeatPromptChars: renderedPrompt.length,
    };

    const buildArgs = (resumeConversationId: string | null): string[] => {
      const args: string[] = [];
      if (model) args.push("--model", model);
      if (resumeConversationId) args.push("--conversation", resumeConversationId);
      if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
      if (sandbox) args.push("--sandbox");
      args.push("--print-timeout", `${printTimeoutSec}s`);
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();
      if (extraArgs.length > 0) args.push(...extraArgs);
      // The prompt must be the value of --print and therefore comes last.
      args.push("--print", prompt);
      return args;
    };

    const commandNotes = (() => {
      const notes: string[] = ["Prompt is passed to Antigravity via --print in headless mode."];
      if (dangerouslySkipPermissions) notes.push("Added --dangerously-skip-permissions for unattended execution.");
      if (sandbox) notes.push("Running with --sandbox terminal restrictions.");
      if (instructionsSection) notes.push("Injected agent instructions into the prompt.");
      if (stagedAssets.stagedSkillsCount > 0) {
        notes.push(`Staged ${stagedAssets.stagedSkillsCount} Paperclip skill(s) into .agents/skills.`);
      }
      return notes;
    })();

    // Snapshot existing conversation ids so the new one can be identified after
    // the run. Local target = read the local brain dir; remote = list it over
    // the target shell (newest-first), degrading to no-capture on hosts where
    // `ls` is unavailable (e.g. Windows OpenSSH with a cmd default shell).
    const localBrainDir = resolveAntigravityBrainDir(runtimeEnv);
    const listConversationOrder = async (): Promise<string[]> => {
      if (!executionTargetIsRemote) {
        const dirs = await snapshotConversationIds(localBrainDir);
        return [...dirs];
      }
      try {
        const probe = await runAdapterExecutionTargetShellCommand(
          runId,
          runtimeExecutionTarget,
          `ls -1At ${REMOTE_BRAIN_LS_DIR} 2>/dev/null`,
          { cwd: effectiveExecutionCwd, env, timeoutSec: 15 },
        );
        return parseBrainListing(probe.stdout);
      } catch {
        return [];
      }
    };
    const detectNewRemoteId = (before: Set<string>, after: string[]): string | null => {
      for (const id of after) if (!before.has(id)) return id;
      return null;
    };

    const runAttempt = async (resumeConversationId: string | null) => {
      const args = buildArgs(resumeConversationId);
      if (onMeta) {
        await onMeta({
          adapterType: ADAPTER_TYPE,
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes,
          commandArgs: args.map((value, index) => (
            index === args.length - 1 ? `<prompt ${prompt.length} chars>` : value
          )),
          env: loggedEnv,
          prompt,
          promptMetrics,
          context,
        });
      }

      const beforeList = await listConversationOrder();
      const before = new Set(beforeList);
      const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
        cwd,
        env,
        timeoutSec,
        graceSec,
        onSpawn,
        onLog,
        runLogTail: paperclipBridge?.runLogTail,
      });
      const afterList = await listConversationOrder();
      const newConversationId = executionTargetIsRemote
        ? detectNewRemoteId(before, afterList)
        : await detectNewConversationId(localBrainDir, before);
      return {
        proc,
        parsed: parseAntigravityOutput(proc.stdout, proc.stderr),
        newConversationId,
      };
    };

    const toResult = (
      attempt: {
        proc: {
          exitCode: number | null;
          signal: string | null;
          timedOut: boolean;
          stdout: string;
          stderr: string;
        };
        parsed: ReturnType<typeof parseAntigravityOutput>;
        newConversationId: string | null;
      },
      clearSessionOnMissingSession = false,
      isRetry = false,
    ): AdapterExecutionResult => {
      if (attempt.proc.timedOut) {
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          clearSession: clearSessionOnMissingSession,
        };
      }

      const failed = (attempt.proc.exitCode ?? 0) !== 0;
      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const fallbackErrorMessage =
        attempt.parsed.errorMessage ||
        stderrLine ||
        `Antigravity exited with code ${attempt.proc.exitCode ?? -1}`;

      const canFallbackToRuntimeSession = !isRetry;
      const resolvedSessionId =
        attempt.newConversationId ?? (canFallbackToRuntimeSession ? sessionId : null);
      const resolvedSessionParams = resolvedSessionId
        ? ({
            sessionId: resolvedSessionId,
            cwd: effectiveExecutionCwd,
            ...(workspaceId ? { workspaceId } : {}),
            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
            ...(executionTargetIsRemote
              ? { remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget) }
              : {}),
          } as Record<string, unknown>)
        : null;

      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage: failed ? fallbackErrorMessage : null,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
        },
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: "google",
        model: model || null,
        costUsd: null,
        resultJson: failed ? { stderr: attempt.proc.stderr } : null,
        summary: attempt.parsed.summary,
        clearSession: Boolean(clearSessionOnMissingSession && !resolvedSessionId),
      };
    };

    const initial = await runAttempt(sessionId);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      isAntigravityUnknownSessionError(initial.proc.stdout, initial.proc.stderr)
    ) {
      await onLog(
        "stdout",
        `[paperclip] Antigravity conversation "${sessionId}" is unavailable; retrying with a fresh conversation.\n`,
      );
      const retry = await runAttempt(null);
      return toResult(retry, true, true);
    }

    return toResult(initial);
  } finally {
    await Promise.all([paperclipBridge?.stop(), restoreRemoteWorkspace?.(), stagedAssets.cleanup()]);
  }
}
