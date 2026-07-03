import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const UUID_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the Antigravity CLI brain directory, where `agy` stores one
 * sub-directory per conversation (named by conversation UUID). The CLI writes
 * to `<home>/.gemini/antigravity-cli/brain`. We honour HOME/USERPROFILE from
 * the run environment so a customised home is respected, falling back to the
 * OS home directory.
 */
export function resolveAntigravityBrainDir(env: Record<string, string>): string {
  const home =
    (typeof env.HOME === "string" && env.HOME.trim()) ||
    (typeof env.USERPROFILE === "string" && env.USERPROFILE.trim()) ||
    os.homedir();
  return path.join(home, ".gemini", "antigravity-cli", "brain");
}

interface ConversationDir {
  id: string;
  mtimeMs: number;
}

async function listConversationDirs(brainDir: string): Promise<ConversationDir[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(brainDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: ConversationDir[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_DIR_RE.test(entry.name)) continue;
    let mtimeMs = 0;
    try {
      const stat = await fs.stat(path.join(brainDir, entry.name));
      mtimeMs = stat.mtimeMs;
    } catch {
      // ignore — treat as oldest
    }
    dirs.push({ id: entry.name, mtimeMs });
  }
  return dirs;
}

/**
 * Snapshot the set of existing conversation ids before a run so the new one can
 * be identified afterwards. Returns a set of conversation-id strings.
 */
export async function snapshotConversationIds(brainDir: string): Promise<Set<string>> {
  const dirs = await listConversationDirs(brainDir);
  return new Set(dirs.map((d) => d.id));
}

/** POSIX path to the Antigravity CLI brain dir, for use in remote shell probes. */
export const REMOTE_BRAIN_LS_DIR = "$HOME/.gemini/antigravity-cli/brain";

/**
 * Parse the output of `ls -1At <brainDir>` (newest-first) on a remote host into
 * an ordered list of conversation-id UUIDs. Non-UUID lines are ignored, so this
 * safely degrades to [] on a Windows host where `ls` isn't available.
 */
export function parseBrainListing(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => UUID_DIR_RE.test(line));
}

/**
 * Identify the conversation id created by the run just completed: any brain dir
 * not present in `before`, preferring the most recently modified one to reduce
 * the chance of picking a stale dir if multiple appeared. Returns null when no
 * new conversation directory was created (e.g. the run failed before the CLI
 * persisted anything).
 */
export async function detectNewConversationId(
  brainDir: string,
  before: Set<string>,
): Promise<string | null> {
  const dirs = await listConversationDirs(brainDir);
  const fresh = dirs.filter((d) => !before.has(d.id));
  if (fresh.length === 0) return null;
  fresh.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return fresh[0]!.id;
}
