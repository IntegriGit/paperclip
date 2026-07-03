export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ParsedLiteLLMResponse {
  content: string;
  finishReason: string | null;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number | null;
  errorMessage: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asNullableNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Parse an OpenAI Chat Completions response body (as returned by LiteLLM).
 *
 * The response is untrusted model output — we only read documented fields as
 * data. Nothing is executed. Missing/odd shapes degrade to safe fallbacks.
 */
export function parseLiteLLMResponse(body: unknown): ParsedLiteLLMResponse {
  const empty: ParsedLiteLLMResponse = {
    content: "",
    finishReason: null,
    model: null,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    costUsd: null,
    errorMessage: null,
  };

  if (!isRecord(body)) return empty;

  // Error envelope: { error: { message } } or { error: "..." }
  if (body.error !== undefined) {
    const err = body.error;
    const message = isRecord(err)
      ? (typeof err.message === "string" && err.message) ||
        (typeof err.code === "string" && err.code) ||
        ""
      : typeof err === "string"
        ? err
        : "";
    return { ...empty, errorMessage: message || "LiteLLM returned an error" };
  }

  const choices = Array.isArray(body.choices) ? body.choices : [];
  const first = choices.length > 0 && isRecord(choices[0]) ? (choices[0] as Record<string, unknown>) : null;
  const message = first && isRecord(first.message) ? (first.message as Record<string, unknown>) : null;
  const content = message && typeof message.content === "string" ? message.content : "";
  const finishReason = first && typeof first.finish_reason === "string" ? first.finish_reason : null;

  const usage = isRecord(body.usage) ? (body.usage as Record<string, unknown>) : {};
  const promptTokens = asNum(usage.prompt_tokens);
  const completionTokens = asNum(usage.completion_tokens);
  const promptDetails = isRecord(usage.prompt_tokens_details)
    ? (usage.prompt_tokens_details as Record<string, unknown>)
    : {};
  const cachedTokens = asNum(promptDetails.cached_tokens);

  const hidden = isRecord(body._hidden_params) ? (body._hidden_params as Record<string, unknown>) : {};
  const costUsd = asNullableNum(hidden.response_cost);

  return {
    content: content.trim(),
    finishReason,
    model: typeof body.model === "string" ? body.model : null,
    promptTokens,
    completionTokens,
    cachedTokens,
    costUsd,
    errorMessage: null,
  };
}

/** Read the per-call cost LiteLLM reports in a response header, if present. */
export function parseCostHeader(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const parsed = Number(headerValue.trim());
  return Number.isFinite(parsed) ? parsed : null;
}
