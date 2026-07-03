export interface ParsedAntigravityOutput {
  /** The agent's printed response text (trimmed). */
  summary: string;
  /** A best-effort error message extracted from stderr, or null. */
  errorMessage: string | null;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

/**
 * `agy --print` emits the agent's response as plain text on stdout. There is no
 * structured event stream, token usage, or cost data to parse. We treat stdout
 * as the response summary and surface the first meaningful stderr line as an
 * error hint when the process fails.
 *
 * Agent output is untrusted (it may contain content the agent fetched or files
 * it read). We only read it as text — nothing here is executed or interpreted.
 */
export function parseAntigravityOutput(stdout: string, stderr: string): ParsedAntigravityOutput {
  const summary = (stdout ?? "").trim();
  const errLine = firstNonEmptyLine(stderr ?? "");
  return {
    summary,
    errorMessage: errLine || null,
  };
}

/**
 * Detect the case where resuming a stored conversation fails because the
 * conversation no longer exists (deleted brain dir, or the known Windows
 * brain-path bug where the CLI cannot locate its transcript directory).
 */
export function isAntigravityUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /conversation\s+(?:.*\s+)?not\s+found|unknown\s+conversation|no\s+such\s+conversation|invalid\s+conversation|cannot\s+find\s+the\s+path|system\s+cannot\s+find\s+the\s+(?:path|file)/i.test(
    haystack,
  );
}
