# IntegriBilt Paperclip Fork — Branch Law

This clone tracks upstream `paperclipai/paperclip` but carries local commits
that production agents depend on. These rules are mandatory.

## Branches

- **`integribilt-main`** — the ONLY branch to run, edit, and commit on.
  It is `upstream-main` plus IntegriBilt commits. The dev server runs from
  this working tree; losing it breaks live Paperclip agents.
- **`upstream-main`** — pristine tracker of `upstream/master`. Never commit,
  never run the server from it, never leave uncommitted work on it.

## Remotes

- `upstream` / `origin` → paperclipai/paperclip (pull only)
- `fork` → IntegriGit/paperclip (push `integribilt-main` here after every
  commit or rebase — it is the offsite backup)

## Updating from upstream

```
git fetch upstream
git checkout upstream-main && git merge --ff-only upstream/master
git checkout integribilt-main && git rebase upstream-main
pnpm install
git push --force-with-lease fork integribilt-main
```

Never `git reset --hard`, `git clean -fd`, or branch-switch away from
uncommitted work. This tree lost the custom adapters TWICE to exactly that.
If work seems lost, check `git stash list` and `git reflog` before anything
else.

## Local-only surface (must survive every rebase)

Custom builtin adapters: `antigravity_local` (agy CLI) and `litellm_local`
under `packages/adapters/`. Their wiring touches:

- `packages/shared/src/constants.ts` (AGENT_ADAPTER_TYPES)
- `packages/shared/src/environment-support.ts` (REMOTE_MANAGED_ADAPTERS)
- `packages/adapter-utils/src/session-compaction.ts`
- `server/src/adapters/{registry,builtin-adapter-types}.ts`
- `server/src/services/environment-execution-target.ts` (ssh allowlist)
- `ui/src/adapters/registry.ts`, `cli/src/adapters/registry.ts`
- workspace deps in `server/ui/cli` package.json + `vitest.config.ts`

Plus Windows fixes: pathToFileURL ESM imports in both plugin loaders,
icacls hardening in `packages/adapter-utils/src/ssh.ts`, and the portable
`server/scripts/copy-onboarding-assets.mjs` build step.

After any rebase, verify with:

```
cd server && pnpm exec tsc --noEmit
pnpm exec vitest run --project '*antigravity*' --project '*litellm*'
curl -s http://127.0.0.1:3100/api/adapters   # expect antigravity_local + litellm_local
```
