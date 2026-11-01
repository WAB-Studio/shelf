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
- Variables (.env format). Secrets are marked; put them in network secrets when the UI offers it.
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
  - `NEXT_PUBLIC_SITE_URL`
  - `DATABASE_URL` (secret)
  - `MIGRATION_DATABASE_URL` (secret)
  - `SUPABASE_SECRET_KEY` (secret)
  - `CRON_SECRET` (secret)
  - `OPENAI_API_KEY` (secret, optional)
  - `TRANSLATE_MYMEMORY_EMAIL`, `TRANSLATE_MYMEMORY_KEY` (secret, optional)
  - `APP_MODEL_CALLS_DAILY_CAP`, `PULSAR_MODEL_STUB` (optional)
  - The same names feed every app: `session-start.sh` writes each app's `.env.local` from them. TimeLog has no `.env.example`.
- Never set `GH_TOKEN` by hand; the proxy injects it.

## What runs on start

- `scripts/cloud/session-start.sh` (SessionStart hook; exits at once unless `CLAUDE_CODE_REMOTE=true`):
  git identity wilson, `npm ci` when the lockfile hash moved, `npx next typegen` per app, `.env.local` per app
  from the variables. Never overwrites an existing `.env.local`. Never fails the session.
- `attribution` in `.claude/settings.json` is blank and `sessionUrl` is false: no trailer, no session link.

## Work

- One cloud session is one lane: `HARNESS_LANE` defaults to 1. `scripts/worktree.sh` refuses.
- Fan out with several cloud sessions, one branch each.
- Run `typecheck` and `lint` as always. A suite needs the local stack: `scripts/supabase-local.sh start`
  (starts Docker first when the daemon is down), then `scripts/supabase-local.sh exec <cmd>`.
- The stack does not survive an idle reclaim: start it again.
- Missing in the cloud: the user's MCP servers (Supabase, Vercel, pulsar are claude.ai connectors or absent), plugins, `settings.local.json`.

## Pull requests

- Use `scripts/gh-rest.sh`. Never `gh pr` or `gh issue`: the proxy refuses GraphQL (403).
  - `scripts/gh-rest.sh pr-create <branch> --title t --body-file f` (base is always integracion)
  - `scripts/gh-rest.sh pr-view <n>`, `pr-checks <n>`, `pr-list`
  - `scripts/gh-rest.sh pr-merge <n> --squash` (refuses a PR that targets main)
- Push works to any branch; deletes and tags are refused.

## Move between machines

- `claude --teleport` pulls a cloud session into the local terminal.
