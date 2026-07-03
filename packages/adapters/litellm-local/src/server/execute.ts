import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  joinPromptSections,
  parseObject,
  renderPaperclipWakePrompt,
  renderTemplate,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_BASE_URL, DEFAULT_CHAT_COMPLETIONS_PATH } from "../index.js";
import { parseCostHeader, parseLiteLLMResponse, type ChatMessage } from "./parse.js";

const ADAPTER_TYPE = "litellm_local";
const DEFAULT_TIMEOUT_SEC = 300;
/** Defensive cap so a single un-rotated session cannot grow without bound. */
const MAX_HISTORY_MESSAGES = 200;

function buildEndpoint(baseUrl: string, chatCompletionsPath: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = chatCompletionsPath.startsWith("/") ? chatCompletionsPath : `/${chatCompletionsPath}`;
  return `${base}${path}`;
}

function readHistory(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const out: ChatMessage[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const role = rec.role;
    const content = rec.content;
    if ((role === "user" || role === "assistant" || role === "system") && typeof content === "string") {
      // Drop persisted system turns — the current system message is rebuilt each run.
      if (role === "system") continue;
      out.push({ role, content });
    }
  }
  return out;
}

async function buildSystemMessage(systemPrompt: string, instructionsFilePath: string): Promise<string> {
  const parts: string[] = [];
  if (systemPrompt.trim()) parts.push(systemPrompt.trim());
  if (instructionsFilePath) {
    const contents = await fs.readFile(instructionsFilePath, "utf8").catch(() => "");
    if (contents.trim()) parts.push(contents.trim());
  }
  return parts.join("\n\n");
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta } = ctx;

  const baseUrl = asString(config.baseUrl, DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  const chatCompletionsPath = asString(config.chatCompletionsPath, DEFAULT_CHAT_COMPLETIONS_PATH).trim() ||
    DEFAULT_CHAT_COMPLETIONS_PATH;
  const endpoint = buildEndpoint(baseUrl, chatCompletionsPath);
  const model = asString(config.model, "").trim();
  if (!model) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "litellm_local adapter requires a `model` in adapterConfig.",
    };
  }

  const systemPrompt = asString(config.systemPrompt, "");
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const temperature = asNumber(config.temperature, NaN);
  const maxTokens = asNumber(config.maxTokens, 0);
  const topP = asNumber(config.topP, NaN);
  const timeoutSec = (() => {
    const t = asNumber(config.timeoutSec, 0);
    return t > 0 ? t : DEFAULT_TIMEOUT_SEC;
  })();
  const extraBody = parseObject(config.extraBody);
  const extraHeaders = parseObject(config.headers);
  const envConfig = parseObject(config.env);

  const apiKey =
    asString(config.apiKey, "").trim() ||
    (typeof envConfig.LITELLM_API_KEY === "string" ? envConfig.LITELLM_API_KEY.trim() : "") ||
    (typeof process.env.LITELLM_API_KEY === "string" ? process.env.LITELLM_API_KEY.trim() : "");

  // Resolve a resumable conversation from the stored session.
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const history = readHistory(runtimeSessionParams.messages);
  const sessionId =
    asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "").trim() || `litellm-${randomUUID()}`;

  // Build the new user turn from the wake prompt (on resume) or the full template.
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const resumed = history.length > 0;
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: resumed });
  const shouldUseResumeDeltaPrompt = resumed && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const userContent = joinPromptSections([wakePrompt, sessionHandoffNote, renderedPrompt]);

  const systemMessage = await buildSystemMessage(systemPrompt, instructionsFilePath);
  const messages: ChatMessage[] = [];
  if (systemMessage) messages.push({ role: "system", content: systemMessage });
  messages.push(...history);
  messages.push({ role: "user", content: userContent });

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    ...extraBody,
  };
  if (Number.isFinite(temperature)) body.temperature = temperature;
  if (maxTokens > 0) body.max_tokens = maxTokens;
  if (Number.isFinite(topP)) body.top_p = topP;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...Object.fromEntries(
      Object.entries(extraHeaders).filter((e): e is [string, string] => typeof e[1] === "string"),
    ),
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  if (onMeta) {
    await onMeta({
      adapterType: ADAPTER_TYPE,
      command: endpoint,
      commandNotes: [
        `POST ${endpoint}`,
        `model=${model}`,
        resumed ? `resuming conversation with ${history.length} prior message(s)` : "new conversation",
      ],
      commandArgs: ["POST", endpoint, `model=${model}`, `<prompt ${userContent.length} chars>`],
      env: {
        LITELLM_BASE_URL: baseUrl,
        LITELLM_MODEL: model,
        AUTHORIZATION: apiKey ? "Bearer ***" : "(none)",
      },
      prompt: userContent,
      promptMetrics: {
        promptChars: userContent.length,
        wakePromptChars: wakePrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
        heartbeatPromptChars: renderedPrompt.length,
        priorMessages: history.length,
      },
      context,
    });
  }

  await onLog("stdout", `[paperclip] POST ${endpoint} (model=${model})\n`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

  let res: Response;
  let rawText: string;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    rawText = await res.text();
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `LiteLLM request timed out after ${timeoutSec}s`,
        errorCode: "timeout",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip] LiteLLM request failed: ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `LiteLLM request failed: ${message}`,
      errorCode: "network_error",
    };
  } finally {
    clearTimeout(timer);
  }

  let json: unknown = null;
  try {
    json = rawText ? JSON.parse(rawText) : null;
  } catch {
    json = null;
  }

  const parsed = parseLiteLLMResponse(json);
  const costUsd = parsed.costUsd ?? parseCostHeader(res.headers.get("x-litellm-response-cost"));
  const failed = !res.ok || parsed.errorMessage !== null;

  if (failed) {
    const detail =
      parsed.errorMessage ||
      (rawText ? rawText.slice(0, 500) : `HTTP ${res.status} ${res.statusText}`);
    await onLog("stderr", `[paperclip] LiteLLM error (HTTP ${res.status}): ${detail}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `LiteLLM request failed (HTTP ${res.status}): ${detail}`,
      provider: "litellm",
      model: parsed.model ?? model,
      usage: {
        inputTokens: parsed.promptTokens,
        outputTokens: parsed.completionTokens,
        cachedInputTokens: parsed.cachedTokens,
      },
      costUsd,
      resultJson: { status: res.status, finishReason: parsed.finishReason },
    };
  }

  if (parsed.content) await onLog("stdout", `${parsed.content}\n`);

  // Persist the conversation: prior history + this user turn + the assistant reply.
  const userTurn: ChatMessage = { role: "user", content: userContent };
  const assistantTurn: ChatMessage = { role: "assistant", content: parsed.content };
  const nextHistory: ChatMessage[] = [...history, userTurn, assistantTurn].slice(-MAX_HISTORY_MESSAGES);

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    usage: {
      inputTokens: parsed.promptTokens,
      outputTokens: parsed.completionTokens,
      cachedInputTokens: parsed.cachedTokens,
    },
    sessionId,
    sessionParams: {
      sessionId,
      messages: nextHistory,
      model,
      baseUrl,
    },
    sessionDisplayId: sessionId,
    provider: "litellm",
    model: parsed.model ?? model,
    costUsd,
    resultJson: { finishReason: parsed.finishReason },
    summary: parsed.content,
  };
}
