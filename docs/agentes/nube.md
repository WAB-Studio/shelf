# Cloud sessions

Read it before you work from claude.ai/code. A cloud session is a fresh Ubuntu VM cloned at one branch;
the repo's `.claude/settings.json`, hooks, `CLAUDE.md`, agents and skills load, the user's own settings do not.

## Create the environment (once, in claude.ai)

- Network: **Custom**, keep the defaults ("Trusted" list), add:
  - `*.supabase.co` (REST, Auth and `db.<ref>.supabase.co`)
  - `*.pooler.supabase.com` (DATABASE_URL and MIGRATION_DATABASE_URL, ports 6543 and 5432)
  - `api.supabase.com`
  - `api.openai.com` (GoalLog and WordBook model calls; stubbed in every test, so only a live run needs it)
  - `api.mymemory.translated.net` (WordBook translation)
  - `open.er-api.com` (HomeFund exchange rates)
  - `*.vercel.com`, `api.vercel.com` (only to deploy or read Vercel from the VM)
- Setup script: paste `scripts/cloud/setup.sh` whole. It reads no repo path, warms the Supabase CLI download
  and exits 0. Docker images are not pulled there (unmeasured; the first `supabase-local.sh start` pulls them).
- Variables: none required. A cloud session holds no production secret.
  - Optional `OPENAI_API_KEY`, as a network secret, to call the real model on purpose.
  - `scripts/supabase-local.sh exec` overlays the local stack's database, keys and empty paid keys on every command.
- Production migrations and anything that touches production stay on the user's PC.
- Never set `GH_TOKEN` by hand; the proxy injects it.

## What runs on start

- `scripts/cloud/session-start.sh` (SessionStart hook; exits at once unless `CLAUDE_CODE_REMOTE=true`):
  git identity wilson, `npm ci` when the lockfile hash moved (stamp written after success), `npx next typegen` per app,
  `.env.local` per app copied from `.env.example` (placeholders, site URL on the lane-1 port). Never overwrites an existing
  `.env.local`. Never fails the session. The hook times out at 900 s.
- `npm ci` stays in the hook: the setup script runs before the repo is guaranteed to be there.
- Warns when `setup.sh` pins another Supabase CLI version than `supabase-local.sh`: paste it again.
- `attribution` in `.claude/settings.json` is blank and `sessionUrl` is false: no trailer, no session link.

## Work

- One cloud session is one lane, lane 1 (`HARNESS_LANE` unset). `scripts/worktree.sh` refuses.
- Fan out with several cloud sessions, one branch each.
- Run `typecheck` and `lint` as always. A suite needs the local stack: `scripts/supabase-local.sh start`
  (starts Docker first when the daemon is down), then `scripts/supabase-local.sh exec <cmd>`.
- The stack does not survive an idle reclaim: start it again.
- Missing in the cloud: the user's MCP servers (Supabase, Vercel, pulsar are claude.ai connectors or absent), plugins, `settings.local.json`.

## Pull requests

- Use `scripts/gh-rest.sh`. Never `gh pr` or `gh issue`: the proxy refuses GraphQL (403).
  - `scripts/gh-rest.sh pr-create <branch> --title t --body-file f` (base is always integracion)
  - `scripts/gh-rest.sh pr-view <n>`, `pr-checks <n>` (check-runs and commit statuses), `pr-list`
  - A raw `gh api …/pulls/<n>/merge` is refused by the guard.
  - `scripts/gh-rest.sh pr-merge <n> --squash` (refuses a PR that targets main)
- Push works to any branch; deletes and tags are refused.

## Move between machines

- `claude --teleport` pulls a cloud session into the local terminal.
