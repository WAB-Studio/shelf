# Verification and what a session spends

How to size a proof is in `AGENTS.md` § Verification. This file holds the rest: suites, judges, CI and cost.
The why: `docs/agentes/historia.md` § Verification.

## Running a suite

- Verify once at the end of a module or slice. Never after a micro-edit.
- Run suites against the local Supabase in Docker (`supabase start`) through `scripts/supabase-local.sh exec`. The
  remote project serves the apps and the RNF-09 timing alone.
- Run at most two whole suites at once against the remote pool: a third exhausts it (`EMAXCONNSESSION`, 15 clients).
  CI and the lanes run on local stacks and do not count.
- Run `next build` at a milestone, never per step. CI builds every app on every pull request that reaches it
  (`build-orbit`, `build-pulsar`, voyager inside `voyager-e2e`); preview deployments are off, so those jobs are the
  only place a broken build is caught before production.
- Make the orbit suite run less, or shard it across harness lanes. At 8 shards setup is 189 of a shard's 574 s
  (run 42927479636), so cache it: `.github/actions/npm-install` restores `node_modules` by lockfile and Node,
  `.github/actions/playwright-chromium` the browser, and the orbit shards their Turbopack build cache.
- Install with those two actions in a new job, never a bare `npm ci` or `playwright install`.
- Append an assertion at the end of its suite, in `apps/homefund/scripts/check-queries.ts` and
  `apps/homefund/scripts/check-http.ts` alike. `Q` and `H` count calls at runtime; inserting in the middle renumbers
  everything below.
- Copy `<app>/private/playwright-results/` into the lane's `private/` before rerunning a suite that went red. A passing
  run wipes it, and the failure's `error-context.md` goes with it.
- Never buy quiet on a flake: no `retry`, no `waitFor`, no `sleep`, no serialized lanes. `retries: 0` is deliberate.
- Never propose a separate Supabase project for e2e. Reopen it only on a recurrence of the `sync.spec.ts` flake with
  its footprint captured (an actual quota error code, not an inference), or on the suite locking a real user out of
  signing in. Save the log the first time.

## E2E scope (decided by the user 2026-11-10)

- Write an HomeFund e2e test only for a happy path of a screen or a user flow, or for the regression of a bug that
  only a browser caught. Two stand today: the split editor's error under Categoría (`movement-money`) and the
  line that says why there is no next payment (`debts`, «Próximo pago»).
- Put a rule about money, data, scope, permission, refusal or arithmetic in `check:queries`, `check-rls`,
  `check:http` or a unit test, never in e2e. Append the assertion at the end of the suite.
- Run the phone project only on tests tagged `@mobile` in the title (`grep` in `playwright.config.ts`; the desktop
  project has `grepInvert`). Tag only what is phone-specific: card lists, the bottom sheet, the 360 px fit, the
  phone's navigation.
- Never write a variant per role, scope, width, theme or state of one screen. The measurement is in
  `docs/agentes/historia.md` § E2E prune.

## Harness accounting

- Run `npm run harness:census` before and after a session that runs suites. The two numbers are its footprint.
- Register every `auth.users` row a script creates through `@repo/harness-registry`. A probe that does not is a leak
  nothing can prune.
- Verify a number a subagent reports before repeating it. A count inferred from attempts is not a measurement.

## Judging

- Since 2026-10-24 the review is `/code-review` then `/simplify` on the branch (`AGENTS.md` § Modules). The
  validator, mutator and critic below run only when the user asks for one.
- The worker saves every check's output under the lane's `private/` and names the paths. The train's validator reads
  those logs, re-runs only the train's own tests, and asks of each assertion whether it can fail. It never re-runs a
  suite a worker logged green: it checks that log ran the right code.
- The mutator runs each mutation against the one test that kills it (`spec:line` or `-g`), never the suite. Wait for
  the server to answer, never a fixed `sleep`. Run the suite once, over the final code.
- Drive pulsar's mutations against `next build` + `next start`, never `next dev`, never `rm -rf .next`.

## CI

- Ship modules that share no file as one train: one branch merging them, one PR, one CI run. A red spec names its module.
- Never wait on CI. Fire it on the train each time a module lands and keep dispatching: cut the next train from the
  one in review, fix a red on its own branch, rebase what sits on top. Merge the PR once CI on the train's branch is
  green on the same commit; do not wait for the PR to run it again.
- Fire the suite on a train's branch before merging it: `gh workflow run ci.yml --ref <branch>`. Merge only when that
  run's `pulsar-e2e` is green.
- Fire it too on any single pulsar PR that touches `messages/`, the template or a screen.
- Run a new pulsar spec under `pulsar-e2e`, fired on its branch, before calling it green.
- `pulsar-e2e` runs on the push only, never on a pull request. Merge a pulsar PR on `fast`, `pulsar-policies` and
  `pulsar-checks`.
- Orbit's `e2e` is informative, not blocking: no check is required by `main`'s ruleset. It runs on a pull request only
  when the change reaches `apps/homefund`, `packages/` or the lockfile, and always on the push to `main`. Merge on
  `fast` and `voyager-e2e`; read a red on `main` and fix forward.
- `fast` is the one seconds-long job: `next typegen` for each app, `typecheck`, `lint`, `check:dict` and `check:unit`
  (WordBook, GoalLog, `packages/harness-registry`). It has no database, browser or secret. Name it, never `typecheck`
  or `lint` alone.
- `voyager-e2e` runs on a pull request only when it reaches `apps/wordbook`, `packages/`, the lockfile or `ci.yml`, and
  always on a push. Skipped, it does not block the merge.
- Fix a red on `integracion` before anything else. Take `integracion` to `main` only with the whole suite green, and
  prove the slice there before that merge, not after.

## What a session spends

- Plan on Opus. Execute on Sonnet. The window is shared across models and an Opus turn costs several Sonnet turns.
- Send a suite's output to a file and grep it. Never read a 12-minute log into the conversation.
- Chase a red with the one spec that failed and the server log. Never by repeating the suite.
- Read a range, not a file: `sed -n 200,260p`. Read a whole file only when you will change most of it.
- Fan out only across tracks that share no file. A fan-out costs about fifteen agents' worth of tokens.
- Every tool call lands in `.claude/usage-log.tsv`. Run the `uso` skill to read where a session went and what repeats
  enough to become a script.

## CI shape (decided by the user 2026-10-15)

- One run per ref: `ci.yml` has `concurrency: ci-${{ github.ref }}` and cancels the older run in progress. `main` is never cancelled.
- Path filters: the `changes` job compares the run against its base (the PR base; the tip before a push to `integracion`; the merge-base with `integracion` on a dispatch) and every app job (`build-orbit`, `build-pulsar`, `pulsar-e2e`, `pulsar-checks`, `orbit-checks`, `e2e`, `voyager-e2e-shard`) runs only when its app, `packages/`, the lockfile or `ci.yml` changed. `main` and a base that cannot be resolved run everything. A skipped job does not block the merge.
- `pulsar-fechas` (the pinned-clock date matrix) is out of `ci.yml`. `pulsar-calendario.yml` runs it nightly and on its own manual dispatch: `gh workflow run pulsar-calendario.yml --ref <branch>`. Its `pins` job computes the pinned dates from the run's date in Bogota; type none by hand.
- `build-pulsar` (`next build` for GoalLog) runs on a pull request only; on a push `pulsar-e2e` and `pulsar-checks` build the same tree.
- `voyager-e2e` runs 2 shards (`voyager-e2e-shard`); the job `voyager-e2e` merges them. The WordBook model-free checks (`check:sync`, `grants`, `sign-in-budget`, `allow-email`, `sign-in-code`, `translate`, `translate-model`, `unlisted`, `admission`) run in the `policies` job, with no paid model. `check:decoration` and `check:notes` run in `voyager-e2e-shard` on shard 1, after the suite (the first seeds today's `model_spend` row), with a blank `OPENAI_API_KEY`. HomeFund's `check:unit` runs in `fast`.
- `pulsar-e2e` runs 6 shards; `pulsar-e2e-report` merges them. Past six, `pulsar-checks` and orbit's `e2e` set the wall time (`private/reportes/ci-costo.md`).
- Orbit's e2e runs 4 shards (`e2e-shard`), each on `next start` over its own build, never `next dev`; the job `e2e` merges them.
- Cache only `.next/cache` (the build's) in CI. Never `.next/dev/cache`: restored, it hung a shard on its first compile.
