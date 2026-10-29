# Lanes

Read it before you open, work in or drop a lane. The why behind each rule: `docs/agentes/historia.md` § Lanes.

## Every agent in a lane

- Lane 1 is the main checkout; lanes 2 and up are worktrees at `../<checkout>-l<n>`.
- Lanes 2 to 6 may run e2e specs; lanes 7 and up take only work with no e2e (docs, words, pure functions,
  `check:*`). The cap is RAM and the shared Auth, not the lane count.
- Take the port from the app: homefund on :300<n-1>, wordbook on :310<n-1>, goallog on :320<n-1>.
- Run an app's npm scripts from its own directory, `apps/homefund`, or from the root with `-w apps/homefund`.
- Work one track per lane. Never two tracks on one lane; never run a lane's suite while another track holds it.
- Run one dev server per worktree. Take `Another next dev server is already running` as: one is up, use it.
- Start a lane's dev server inside `scripts/supabase-local.sh exec`. Bare, it reads the remote project and every
  minted session fails with `linkInvalid`.
- Take a change out with `git diff > private/neg.patch && git apply -R`; put it back with
  `git apply private/neg.patch`. Keep the patch inside the lane, never in `/tmp`: `/tmp` is one directory for every lane.
- Free a port with `fuser -k <port>/tcp`.
- Run `npm install` at the lane's root when a workspace package landed after the lane opened. Its copied
  `node_modules` has no link to it, so `typecheck` fails there while the main checkout and CI are clean.
- Generate a migration early. Apply it last, after typecheck and lint are clean over every file it touches.
  See `docs/TRAPS.md`, "One database, many branches".
- Never run two agents that write `reading.word_texts` or spend `reading.model_spend` at once. `HARNESS_LANE` does not
  scope those tables. See `docs/TRAPS.md`, "One database behind every harness lane".

## Harness lanes

- Set `HARNESS_LANE=n` to give a track its own identities, session files, storage states and seeded rows.
- Leave it unset for lane 1. `HARNESS_LANE=1` is the same lane.
- Run any suite through the local stack: `HARNESS_LANE=2 scripts/supabase-local.sh exec npm run check:e2e`.
- Take `harness: <host> is not the local stack` as: wrap the command in `scripts/supabase-local.sh exec`. Set
  `HARNESS_DATABASE=remote` only for the RNF-09 timing (`check:http`, `check:queries` against the remote).
- Run the RNF-09 timing alone. A second lane on the same server inflates it.
- Share one dev server between lanes, or point a lane at its own with `HARNESS_BASE_URL`.
- Run pulsar specs as `apps/goallog/AGENTS.md` says. Its Playwright ignores `HARNESS_BASE_URL`.
- `scripts/worktree.sh` bootstraps a lane. Bootstrap one by hand only outside a worktree:
  `HARNESS_LANE=2 scripts/supabase-local.sh exec npm run harness:token`. It creates `harness-2@example.invalid` and
  `harness-member-2@example.invalid` and lands their token rows.
- Land a fresh token the same way when a lane's session file is lost.
- Never age a harness run by hand to make `harness:reap` fire. `heartbeat_at`, `started_at` and `finished_at` in
  `harness.runs` are written by `@repo/harness-registry` and nothing else. A check that needs a dead run waits the
  real threshold, or asserts the delete path on a run it created dead. The same `UPDATE` with another `WHERE` prunes a
  live lane's identity out from under it.
- Run `harness:reap` only when every lane is quiet; it refuses while any heartbeat is fresh. It never touches a lane
  identity.
- Give a lane opened with `--app goallog` its identities before GoalLog's database checks: copy `apps/homefund/.env.local`
  into it and run `HARNESS_LANE=<n> scripts/supabase-local.sh exec npm run harness:token` from its `apps/homefund`.
- Run `harness:census` from the main checkout when the lane is single-app. A lane opened with `--app wordbook` copies
  no `apps/homefund/.env.local`, so the census dies there. Both checkouts share one database.

## The session that opens lanes

- Open a lane: `scripts/worktree.sh <lane> <branch> [base] [--app <name>]`. It costs 4 seconds.
- `--app` defaults to `homefund` and takes `homefund`, `wordbook` or `goallog`. An app with no database copies no
  `.env.local` and mints no identity, so its lane opens with the database unreachable. An unknown name refuses.
- Rebase a branch cut before a folder rename with `git -c merge.directoryRenames=true rebase <base>`. Without it the branch's new files conflict (`UA`).
- Open a lane by hand for an app not yet committed on the base:
  `git worktree add -b <branch> ../<checkout>-l<n> <base> && cp -al node_modules ...`.
- Re-copy a plan into the lane before you dispatch: `worktree.sh` copies `private/` plans at birth only. Carry the
  report back by hand.
- Split the work before you start it. A track per defect, per module, per screen.
- Cut a lane's branch from the branch it serves: `integracion` for a module of the slice in hand, not `main`.
- Fast-forward `integracion` to `main` when a slice opens, before cutting anything from it.
- Rebase a branch onto its base before merging when another branch moved a file it names. Two branches cut from one
  base are each green alone and red together.
- Forbid a file to every live lane the moment you hand it out, not only to the lanes you open next.
- Assign the migration number by hand when two lanes may generate one. Renumbering after is safe (drizzle matches on
  the SQL's hash: keep the entry's `when`, rename file, tag and snapshot), but the merge collides in
  `meta/_journal.json`.
- Run at most four lanes with a dev server or a suite at once: each takes 1.5 to 2 GB, and five filled the 15 GB WSL and its swap on 2026-10-22. The user raised the cap from two to four on 2026-10-22 («HABILITA MAS CARRILES»). Keep the main checkout's :3000 down while lanes run.
- Stop a lane's dev server when its agent returns, and drop the lane when its branch merges.
- Copy everything an agent left in the lane before you drop it: `cp -r ../finances-app-l<n>/private/{reportes,ux-*} private/`
  and the lane's `apps/*/private/`. `worktree remove --force` deletes them.
- Drop the worktree when its branch lands: `git worktree remove ../finances-app-l<n> --force`.
