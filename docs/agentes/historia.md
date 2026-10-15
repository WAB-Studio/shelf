# Why the agent rules are what they are

The measurements and the user's decisions behind the rules in `AGENTS.md` and `docs/agentes/`.
Read it before arguing with a rule. Never load it to follow one: the rules stand without it.
Each entry names the rule and the file it lives in now.

## Orchestration (`.claude/skills/orchestrator/SKILL.md`)

- Scope a slice's critic to what the slice broke; Thin goes to `private/pulido.md`. Decided by the user 2026-10-14,
  after s5 to s8 each grew out of the last critic's small findings, several of them there since the first round.
- Tester before worker on every screen module. Decided by the user 2026-10-06, after four modules in one evening went
  worker → validator → worker over clauses nobody had tested. Narrowed by the user 2026-10-14 to the risk table's
  level 3 (`AGENTS.md` § Modules), then restored for a new screen on 2026-10-15 (see the review entry below).
- Words-only module to one agent that writes its Done table red first. Decided by the user 2026-10-10.
- Judge per train, never per module. Decided by the user 2026-10-12: per-module judging and per-test mutations took
  more than half of each module's time (one `next build` per mutation).
- The mutator's 30 minutes a train. Decided by the user 2026-10-12: tren i1's mutator ran ~430 mutations in ~3 h and
  held the PR for nothing.
- Cut a slice by layer, about eight modules. Decided by the user 2026-10-12: every handoff between agents cost 5 to
  15 minutes.
- Every agent writes its report to a file and returns three lines. Decided by the user 2026-10-12: reading every
  report in full drained the window at 500k with work still running.
- Two slices at once. Decided by the user 2026-10-12: the import slice starts beside the hierarchy's last screens.
- Ask the user only what they alone can decide, whole. Decided by the user 2026-09-27, after seven questions in one
  message, five of them unreadable without the session behind them.
- Fix the slice's list before it starts. Decided by the user 2026-10-11, after trains 9, 10 and 11 each grew out of
  the last one's findings and «unas horas» never came.
- Never tell the user to rotate a credential. Decided by the user 2026-09-10.
- Name the query that feeds a screen before dispatching it. It happened twice: module 16 read a mark no writer sets,
  module 14 drew data no query selects.
- Never hold work behind a judge. Decided by the user 2026-10-11: «esperar a los agentes multiplica el tiempo».
- The window's close at 500k. Decided by the user 2026-10-10; raised from 300k on 2026-10-11: 300k drained the
  session before the trains were done.
- Risk table, module size cap, judge-performance table and pruning, and «a reviewer with no findings is a valid
  result». Decided by the user 2026-10-14 («hagamos todo lo de investigación estratégicas»), from
  `private/investigacion-estrategias.md` Part C and A5.

## Retired 2026-10-14 by the user

- «Never close a slice on a report of greens alone. A slice with no criticism in it was not reviewed.» Successor:
  «A slice is reviewed when a reviewer read it in a clean context; a reviewer with no findings is a valid result.»
  Why: a reviewer asked to find gaps reports some even when the work is sound.
- In `.claude/agents/critic.md`: «A report with no criticism in it is a report that was not written.» Same successor.
- Canvas upkeep, from «Keep each canvas current, like a Figma file a team works from» (decided 2026-10-05: «tenemos
  como 8 tabs y nunca vamos limpiando y agrupando… siempre queda el artifact con cosas antiguas y sin resultados
  reales»). Decided by the user 2026-10-14: keep the boards; drop the index page with each board's state, the
  replacement of a board with a capture of the real screen the day its module lands, and «a canvas behind
  `integracion` is a defect». Kept: draw the board and take the user's answer before any screen; one page per area;
  move a superseded board to «Archivo» the same day.
- The prose of the rules hooks now enforce (`.claude/settings.json`): no `git stash`, commit as wilson, no Claude
  trailer, PRs to `integracion`, no `pkill -f`, no `gh pr merge` chained with a delete, no push to `main`.
  Their evidence stays below.

## Design (`docs/agentes/canvas.md`)

- One board per state, a second face only where the design changes. Decided by the user 2026-09-10, after four
  faces of one state went up and three of them were a regex over the fourth.
- Paste the board's words and structure into the dispatch. On 2026-10-05 module 191 invented half its copy and
  module 169 drew a card the board does not have, both because the worker could not see the board.

## Lanes (`docs/agentes/lanes.md`)

- Lanes 2 to 6 take e2e. Decided by the user 2026-10-05, raised from four to five lanes 2026-10-06.
- Five suites at once. Decided by the user 2026-10-05 (four) and 2026-10-06 (five): 15 GB, 7 GB still free with
  three running.
- Keep the patch inside the lane. On 2026-10-06 lane 5 re-applied a `/tmp/x.patch` lane 4 had overwritten and took
  its `month-screen.tsx` diff.
- Rebase before merging when another branch moved a file. On 2026-09-08 a spec importing
  `../../orbit/scripts/harness/registry` and a package promotion landed twenty minutes apart and broke `main`. The
  promotion's own guard grepped `../../../` and never saw the two-dot import.
- Copy the lane's `private/` before dropping it. Measured 2026-10-06: 144 captures of two UX critics went with lanes
  3 and 6. Measured 2026-10-13: the canvas capture scripts in `apps/pulsar/private/cap/` went with lane 3.
- Assign the migration number by hand. Two lanes took `idx 43` the same afternoon and both applied.
- `harness:reap` refuses while a heartbeat is fresh. Measured 2026-09-29: `BLOCKED a live run holds harness.runs`.

## Git (`.claude/skills/orchestrator/SKILL.md` § Git)

- `gh pr merge --squash` signs with the GitHub account. Decided by the user 2026-09-09; see `docs/TRAPS.md`.
- Fetch before you compare. Measured 2026-09-20: this checkout's `main` had sat at the 2026-09-10 merge for nine
  days, 81 commits behind, and a session reported `integracion` as 93 commits ahead of `main` when it was 14.
- Delete a train's module branches when the train merges. Measured 2026-10-12: 98 branches alive, ~95 of them module
  branches already inside a merged train; one held a fix that never landed.
- Restore `integracion` after merging it into `main`. Measured 2026-10-13 on #592.
- Never chain the delete after `gh pr merge`. On 2026-10-09 a merge refused on a conflict still deleted #526's
  branch, and GitHub closed the PR.
- Commit or push a worker's branch from the main session. Decided by the user 2026-09-27 (push) and 2026-09-30
  (commit).
- `integracion` → `main` once per slice. Measured 2026-09-08: 13 merges to `main` in one session, 13 deployments,
  and Vercel refused the rest for 24 hours. On the free plan the quota is the budget, not the build. Decided by the
  user that day.
- Docs ride with their work. Measured 2026-09-08: 4 of the day's 17 PRs were docs alone, three of them one Markdown
  file, and each cost two Vercel deployments per push.
- `main` refuses a direct push. Measured 2026-09-11: `git push origin main` is rejected with
  `GH013 ... Changes must be made through a pull request`, even fast-forward and with every check green.
- A branch with no merged PR is not automatically dead: `ruta-definir` held a schema sketch for `RL-29`, retired and
  never built.

## Verification (`docs/agentes/verificacion.md`)

- Size the proof by reach. Decided by the user 2026-10-05: module 182 spent 22 minutes re-running suites its new,
  unimported file could not break, and each module paid the same suite up to three times (worker, validator, CI).
- Run every `check:*` that imports a changed action. Measured 2026-09-29: module 88 made `addCommitment` refuse an
  ended goal and broke three `check:day` probes nobody ran.
- The whole e2e runs in CI. A chosen list missed `deshacer.spec.ts` and `cifra-unidad.spec.ts` on 2026-09-30; CI
  caught them.
- The validator reads the worker's logs and never re-runs a suite logged green. Decided by the user 2026-10-10.
- Mutations against the one test. Measured 2026-10-10: module 702 spent ~36 s of each ~50 s cycle on 59 tests and
  8 s asleep.
- Pulsar mutations on `next build` + `next start`. Decided by the user 2026-10-10, proved on module 723 the same day:
  30 tests alike under both; the specs took 57 s on the build and 2.4 min on dev.
- A new pulsar spec under `pulsar-e2e`. A spec that measures boxes passed 182/0 locally and failed in CI, where
  `loading.tsx` still stood.
- `pulsar-e2e` on the push only. Decided by the user 2026-10-05, twice: the second time with the suite at ~2 min.
- Never wait on CI. Decided by the user 2026-10-14: «eso de que me trabo por 10 mins».
- Fire the suite on a train's branch. Measured 2026-10-05: it caught tren 4's rail duplicates after the merge and
  tren 5's `week.today` before it.
- Fire it on a single pulsar PR touching `messages/`. Measured 2026-10-09: 584 added `ritmo:` to the template's
  example, merged on the PR checks, and left `importar.spec.ts` red on `integracion` for a session.
- Orbit's `e2e` informative: no check is required by `main`'s ruleset, verified 2026-09-08.
- `voyager-e2e` on reach only. Decided by the user 2026-10-10.
- The orbit suite is 17 minutes; 1043 of its 1099 seconds are the suite itself, setup is 48.
- Verify a subagent's number. One reported seven leaked `auth.users` rows; the table held two. The census said
  seven, then four, then zero inside one day.
- Local Supabase for suites. Decided by the user 2026-10-05, after PR #390 and #391 went red on 30 s timeouts and
  `linkTimeout` while lanes and CI shared one remote Postgres and Auth.
- A separate Supabase project for e2e, measured and refused 2026-09-09. `sync.spec.ts` mints 3 sign-ins per run, 15
  across five lanes, far under any plausible Auth rate limit. The flake that raised it was not reproduced in 93
  `verifyOtp` calls over four attempts; CI passed that commit 68/68. No measurement ever showed an exhausted quota.
  The real cost of one shared project is accumulation: that day's census read
  `harness-member@example.invalid refresh_tokens=182`, `audit_log both-null-delete 54254`, 148 MB, and the registry,
  census and reap already hold it (0 unregistered rows). A second project buys a second key set, two schemas to
  keep in step, new CI secrets and a touch of `apps/voyager/.env.local`.
- Copy `playwright-results/` before a rerun. Measured 2026-09-10: a `signInAs` red in `registro.spec.ts` under load
  (the redirect carried `error=`) was gone before it could be read, because the rerun that proved it a flake deleted
  the directory. The second footprint lost that way; the first is why the separate-project question stays closed.

## WordBook (`docs/agentes/voyager.md`)

- Never type an address into `/cuenta`. Measured 2026-09-10: a critic typed `lector.prueba@example.com`, the send
  bounced into the user's inbox, and the census found seven ghost rows from three days (`lector@example.com` and
  five `nietoc0595+voyager-rate-N@gmail.com`). All seven deleted that day.
- Never disable the deliverability guard. Measured 2026-09-10, two hours after the rule above: a worker did exactly
  that and minted two more rows and two more bounces.
- Leave `apps/voyager/.env.local` alone. Decided by the user 2026-09-08. Do not raise it again. Copy it unchanged into
  a voyager lane: decided by the user 2026-10-05.

## Code (`AGENTS.md` § Code)

- An inline `style={{…}}` or a CSS module counts as a utility class. Decided by the user 2026-10-08.
- Storage only from `lib/`, never a lint disable. Decided by the user 2026-09-19.
- Revoke ALL from `anon`, `authenticated` and `service_role` in every migration that creates a table: Supabase grants
  them all at `CREATE TABLE`, so a table nobody revoked is open to every role.

## Names (`AGENTS.md` § Apps)

- HomeFund, WordBook, GoalLog. Decided by the user 2026-10-14: «no se entiende rápidamente qué es». Folders
  `apps/homefund`, `apps/wordbook`, `apps/goallog` at the rename slice; Vercel projects renamed the same, old URLs kept
  working; the GitHub repo stays `universe`.

## Review of the AGENTS.md restructure (`AGENTS.md`, `docs/agentes/`)

- The user reviewed the 120-line core plus `docs/agentes/` and approved all 12 process changes on 2026-10-15, with one
  adjustment. Decided by the user 2026-10-15.
- The adjustment (change 1, the risk table): level 2 splits. A NEW screen, or a new state of one, keeps `tester` →
  `worker`; a change to an existing screen, or a query, with none of level 3, is one `worker` that writes its own Done
  table red first. The 2026-10-14 narrowing of the tester to level 3 stands for the second case only.
- Change 2, the 400-line cap, counts the module's code, not its tests.
- The review found four partial losses, now restored: the `/cuenta` rule in every WordBook dispatch (orchestrator
  skill), the rename's destination names (core, § Apps and contracts), `**Bloqueado:**` in plan-watch (orchestrator
  skill) and the reason behind revoking ALL (above).
