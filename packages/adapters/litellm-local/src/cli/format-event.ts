import pc from "picocolors";

/**
 * The litellm_local adapter emits plain text: a `[paperclip] ...` request note
 * followed by the model reply. Dim the notes, print the reply in green.
 */
export function printLiteLLMStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.replace(/\r$/, "");
  if (line.trim().length === 0) return;

  if (line.startsWith("[paperclip]")) {
    console.log(pc.gray(line.trim()));
    return;
  }

  console.log(pc.green(line));
}
