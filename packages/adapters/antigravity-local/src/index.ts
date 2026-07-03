export const type = "antigravity_local";
export const label = "Antigravity (local)";

export const SANDBOX_INSTALL_COMMAND = "agy update";

/**
 * Antigravity's CLI (`agy`) does not expose a stable, machine-readable list of
 * `--model` identifiers in a non-interactive way (`agy models` renders a
 * TTY-gated table that produces no output when piped). Rather than ship guessed
 * model ids that may not exist on a given account, the dropdown is intentionally
 * left empty: leave the model field blank to use Antigravity's configured
 * default, or run `agy models` in a real terminal to discover ids for your
 * account and type one in.
 */
export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# antigravity_local agent configuration

Adapter: antigravity_local

Runs Google's Antigravity headless agent CLI (\`agy\`) locally on the host that
runs Paperclip. \`agy\` shares OAuth/login with the installed Antigravity IDE.

Use when:
- You want Paperclip to drive the Antigravity agent (\`agy\`) locally and pick the model
- You want resumable Antigravity conversations across heartbeats (\`--conversation <id>\`)
- The task benefits from Antigravity's built-in tools (browser, terminal, code edits)

Don't use when:
- You only need a one-shot script without an AI coding agent loop (use the "process" adapter)
- You need a webhook-style external invocation (use "http" or "openclaw_gateway")
- The \`agy\` CLI is not installed or not authenticated on the machine that runs Paperclip
- You need precise token/cost accounting — \`agy --print\` returns plain text only and
  reports no usage or cost (Paperclip records zeros for this adapter)

Core fields:
- cwd (string, optional): absolute working directory for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file. Its contents are injected into the run prompt.
- promptTemplate (string, optional): run prompt template (\`{{path.to.value}}\` rendering)
- model (string, optional): Antigravity model id passed via \`--model\`. Leave blank to use Antigravity's default. Run \`agy models\` to discover ids.
- command (string, optional): defaults to "agy". On Windows you may point this at the absolute path to agy.exe (e.g. %LOCALAPPDATA%\\\\agy\\\\bin\\\\agy.exe).
- dangerouslySkipPermissions (boolean, optional, default true): pass \`--dangerously-skip-permissions\` so the agent runs unattended without tool-approval prompts. DANGEROUS — the agent can run any tool/command without confirmation. Set false for supervised use.
- sandbox (boolean, optional, default false): pass \`--sandbox\` to run with terminal restrictions enabled.
- printTimeoutSec (number, optional): value for \`--print-timeout\` (seconds). Defaults to the run timeout, or 600s when no run timeout is set.
- extraArgs (string[], optional): additional CLI args appended before the prompt
- env (object, optional): KEY=VALUE environment variables for the agent process

Operational fields:
- timeoutSec (number, optional): hard run timeout in seconds (0 = no Paperclip-side timeout)
- graceSec (number, optional): SIGTERM grace period in seconds (default 20)

Remote execution (run agy on another host):
- Supports Paperclip SSH "environments". Assign the agent a remote environment (defaultEnvironmentId)
  and \`agy\` runs on that host over SSH; the workspace is synced there and restored after. Leave the
  environment unset to run locally on the Paperclip host.
- Prerequisites on every target host: \`agy\` must be installed AND authenticated there. \`agy\` shares
  the Antigravity IDE's OAuth (interactive sign-in), so headless/Linux hosts without a signed-in
  Antigravity install will fail the auth probe. Confirm with "Test environment".
- Set \`command\` to the host's agy path when it isn't on PATH.

Notes:
- Prompts are passed to \`agy\` via \`--print <prompt>\` in headless mode.
- Conversation continuity: after a successful run the new conversation id is read from the Antigravity
  CLI brain directory (\`~/.gemini/antigravity-cli/brain/<id>\`) — locally via the filesystem, remotely
  via an \`ls\` over the target shell (resume works on POSIX hosts; Windows-over-SSH may run stateless).
  Subsequent runs resume with \`--conversation <id>\` when the saved cwd and execution identity match.
- If a stored conversation can no longer be resumed, the run retries once with a fresh conversation.
- Paperclip skills are staged into \`.gemini/antigravity/skills\` in the (synced) workspace for
  best-effort Antigravity discovery, and removed afterward.
`;
