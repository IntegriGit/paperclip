import type { TranscriptEntry } from "@paperclipai/adapter-utils";

/**
 * The litellm_local adapter streams a `[paperclip] ...` request note and then
 * the model's reply text via onLog. Map Paperclip notes to `system` entries and
 * everything else to assistant output. Blank lines are dropped.
 */
export function parseLiteLLMStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const text = line.replace(/\r$/, "");
  if (text.trim().length === 0) return [];

  if (text.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: text.trim() }];
  }

  return [{ kind: "assistant", ts, text }];
}
