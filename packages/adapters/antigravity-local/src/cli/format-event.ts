import pc from "picocolors";

/**
 * `agy --print` emits plain text, not a JSON event stream. For `paperclipai run
 * --watch` we print Paperclip's own `[paperclip] ...` notes dimmed and the
 * agent's response text in green, so the live transcript stays readable.
 */
export function printAntigravityStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.replace(/\r$/, "");
  if (line.trim().length === 0) return;

  if (line.startsWith("[paperclip]")) {
    console.log(pc.gray(line.trim()));
    return;
  }

  console.log(pc.green(line));
}
