import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import type { ChatMessage } from "./parse.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const out: ChatMessage[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const role = rec.role;
    const content = rec.content;
    if ((role === "user" || role === "assistant" || role === "system") && typeof content === "string") {
      out.push({ role, content });
    }
  }
  return out;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    const messages = readMessages(record.messages);
    if (!sessionId && messages.length === 0) return null;
    const model = readNonEmptyString(record.model);
    const baseUrl = readNonEmptyString(record.baseUrl);
    return {
      ...(sessionId ? { sessionId } : {}),
      messages,
      ...(model ? { model } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    const messages = readMessages(params.messages);
    if (!sessionId && messages.length === 0) return null;
    const model = readNonEmptyString(params.model);
    const baseUrl = readNonEmptyString(params.baseUrl);
    return {
      ...(sessionId ? { sessionId } : {}),
      messages,
      ...(model ? { model } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { parseLiteLLMResponse, parseCostHeader } from "./parse.js";
