import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import { parseAntigravityOutput } from "./parse.js";

const ADAPTER_TYPE = "antigravity_local";
const DEFAULT_COMMAND = "agy";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function summarizeProbeDetail(stdout: string, stderr: string): string | null {
  const raw = firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

const AGY_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|login\s+required|run\s+`?agy\s+login`?|authentication\s+required|unauthorized|invalid\s+credentials|please\s+sign\s+in)/i;
const AGY_QUOTA_RE = /(?:resource_exhausted|quota|rate\s*limit|429)/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, DEFAULT_COMMAND).trim() || DEFAULT_COMMAND;
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `agy-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "agy_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  const env = normalizeEnv(config.env);

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, { cwd, env, createIfMissing: true });
    checks.push({ code: "agy_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (err) {
    checks.push({
      code: "agy_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, { ...process.env, ...env });
    checks.push({ code: "agy_command_resolvable", level: "info", message: `Command is executable: ${command}` });
  } catch (err) {
    checks.push({
      code: "agy_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: targetIsRemote
        ? "Install the Antigravity CLI (`agy`) on the target host and ensure it is on PATH (or set an absolute `command`)."
        : "Install the Antigravity CLI (`agy`) and ensure it is on PATH, or set an absolute `command` path.",
    });
  }

  const canRunProbe = checks.every(
    (check) => check.code !== "agy_cwd_invalid" && check.code !== "agy_command_unresolvable",
  );

  if (canRunProbe) {
    const probeTimeoutSec = Math.max(5, asNumber(config.helloProbeTimeoutSec, 60));
    const probe = await runAdapterExecutionTargetProcess(
      runId,
      target,
      command,
      ["--print-timeout", `${probeTimeoutSec}s`, "--print", "Reply with exactly: hello"],
      { cwd, env, timeoutSec: probeTimeoutSec, graceSec: 5, onLog: async () => {} },
    );
    const combined = `${probe.stdout}\n${probe.stderr}`;
    const authRequired = AGY_AUTH_REQUIRED_RE.test(combined);
    const quotaHit = AGY_QUOTA_RE.test(combined);
    const parsed = parseAntigravityOutput(probe.stdout, probe.stderr);
    const detail = summarizeProbeDetail(probe.stdout, probe.stderr);

    if (probe.timedOut) {
      checks.push({
        code: "agy_hello_probe_timed_out",
        level: "warn",
        message: "Antigravity hello probe timed out.",
        hint: "The model call may be slow or quota-limited. Retry, or run `agy --print \"hello\"` manually on the host.",
      });
    } else if (authRequired) {
      checks.push({
        code: "agy_auth_required",
        level: "warn",
        message: targetIsRemote
          ? "Antigravity CLI is not authenticated on the target host."
          : "Antigravity CLI is not authenticated.",
        ...(detail ? { detail } : {}),
        hint: "Sign in to Antigravity on that host (the CLI shares the IDE's OAuth), then retry.",
      });
    } else if (quotaHit) {
      checks.push({
        code: "agy_quota_exhausted",
        level: "warn",
        message: "Antigravity returned a quota/rate-limit response.",
        ...(detail ? { detail } : {}),
        hint: "Wait for the quota window to reset or choose a different `model`.",
      });
    } else if ((probe.exitCode ?? 1) !== 0) {
      checks.push({
        code: "agy_hello_probe_failed",
        level: "error",
        message: "Antigravity hello probe failed.",
        ...(detail ? { detail } : {}),
      });
    } else if (/\bhello\b/i.test(parsed.summary)) {
      checks.push({ code: "agy_hello_probe_passed", level: "info", message: "Antigravity hello probe succeeded." });
    } else {
      checks.push({
        code: "agy_hello_probe_unexpected_output",
        level: "warn",
        message: "Antigravity hello probe completed but returned unexpected output.",
        ...(detail ? { detail } : {}),
      });
    }
  }

  return {
    adapterType: ADAPTER_TYPE,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
