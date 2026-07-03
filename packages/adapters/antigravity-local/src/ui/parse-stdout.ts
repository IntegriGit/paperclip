import type { TranscriptEntry } from "@paperclipai/adapter-utils";

/**
 * `agy --print` emits plain text (the agent's response). There is no structured
 * event stream, so we map each output line to a transcript entry: Paperclip's
 * own `[paperclip] ...` notes become `system` lines, everything else is treated
 * as assistant output. Blank lines are dropped.
 */
export function parseAntigravityStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const text = line.replace(/\r$/, "");
  if (text.trim().length === 0) return [];

  if (text.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: text.trim() }];
  }

  return [{ kind: "assistant", ts, text }];
}
