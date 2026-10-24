<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Shelf: HomeFund, WordBook, GoalLog

This file is the core every agent loads. Read the file the index names before the work it names.

## Apps and contracts

- Call the apps by their names: `apps/homefund` is **HomeFund**, `apps/wordbook` **WordBook**, `apps/goallog` **GoalLog**,
  `apps/portal` «Shelf». Vercel projects: `homefund`, `wordbook`, `goallog`; the repo is `WAB-Studio/shelf`. Production deploys the
  old folders until the final merge moves each to `<app>app.vercel.app`; `our-piggy-bank`, `reading-neon`, `pulsar-psi-six` keep answering.
- HomeFund: contract `docs/SPEC.md` §1, model and invariants §2, stack §4, flows `docs/FLOWS.md`, design `docs/DESIGN.md`.
- WordBook: `docs/wordbook/SPEC.md`, `docs/wordbook/DESIGN.md`. GoalLog: `docs/goallog/SPEC.md`, `docs/goallog/DESIGN.md`.
  Shelf: `docs/portal/DESIGN.md`. Give every app its own design; never carry a pattern across.
- `apps/` holds the apps, `packages/` the code two of them share: npm workspaces, one lockfile, `node_modules` hoisted
  to the root (a script reaches a binary as `../../node_modules/...`). Promote nothing until a second app asks for it.
- `docs/`, `private/`, `.claude/` and `scripts/worktree.sh` govern every app and stay at the root.
- `apps/portal` is one static page with no build, live at https://universo-apps.vercel.app until its Shelf address ships with the deploy. Deploy it by hand from
  `apps/portal` with `npx vercel deploy --prod --yes`; update its links when an app's URL changes.
- Add `https://<the app's URL>/auth/confirm` to Supabase's Redirect URLs before an app that signs in by email first deploys.

## Index

- `docs/agentes/lanes.md`: opening, working in and dropping a lane; `HARNESS_LANE`; the harness.
- `docs/agentes/verificacion.md`: suites, judges, CI, what a session spends.
- `docs/agentes/canvas.md`: the canvases, when the user asks for a drawing.
- `docs/agentes/wordbook.md`: WordBook's `/cuenta`, auth, keys and census.
- `docs/agentes/historia.md`: the measurements and decisions behind these rules.
- `docs/TRAPS.md`: read it before writing a query, a migration or a spec.
- `docs/TRAPS-archivo.md`: traps whose cause is gone. Read it only to learn why a rule exists.
- `apps/<app>/AGENTS.md`: what holds inside one app. Loaded when you work there.
- «iniciemos» and «cerremos handoff»: the `handoff` skill. To develop: the `orchestrator` skill (one session, § Modules).

## Working here

- Ask only what the user alone can decide, whole (options, costs, pick), in the chat; work on what does not wait for it.
- Use the credential the user hands you. Never tell the user to rotate, revoke or replace one.
- Work in your own lane: its worktree, its port, its `HARNESS_LANE`. Ports: homefund :300<n-1>, wordbook :310<n-1>,
  goallog :320<n-1>. Wrap every suite and dev server in `scripts/supabase-local.sh exec`.
- Keep plans in `private/`, and a lane's patches and logs in its own `private/`, never in `/tmp`.
- Never type an address into WordBook's `/cuenta`: it sends a real email. See `docs/agentes/wordbook.md`.

## Modules

- Work in one session. Write the code and its tests together; spawn a subagent only for work that truly runs in parallel.
  Decided by the user 2026-10-24: «no hacemos todo este circo de agentes».
- Build a screen straight from its `DESIGN.md` words. Draw no board first; show the screen when it is done.
- Review before merging: run `/code-review` on the branch's diff, then `/simplify`. Fix what they find; that is the review.
- Keep a module to one diff a person reads at once: about 400 changed lines of code, tests not counted.
- Report in two lines: what landed and what blocks. No report files, no roadmap update per step.

## Code

- Store money as integer cents. Floating point is forbidden.
- Derive balances from movements. Never store them in a column.
- Derive the transaction type from the accounts involved.
- Revoke ALL from `anon`, `authenticated` and `service_role` in every migration that creates a table.
- Prove a policy fires by driving it. Never assert it from the migration.
- Count round trips to Postgres, not queries. Settle the session in one statement, never one per `set_config`.
- Fan a screen's queries out with `Promise.all`, the fund guard included. Never chain the awaits.
- Validate on the server with the same Zod schema that validates the form.
- Move every interface string into next-intl. Hardcoding is forbidden.
- Compose a screen from `components/ui` and its props. Never write a utility class, an inline `style={{…}}` or a CSS
  module outside it. Add a prop to the primitive for a variant; never patch one from outside.
- Reach `localStorage`, `sessionStorage` and IndexedDB from `lib/` alone. Never silence the lint rule with a disable.
- Install only from `docs/SPEC.md` §4, nothing on its «Do not install» list. Leave `apps/wordbook/.env.local` alone.
- Write code and identifiers in English. Write user-facing copy in the user's language. Interface text: what a person acts on.
- Comments: say what the code does not, one idea each. Never restate the line below. Never log a change, a date, an
  author or a ticket.

## Requirements

- Never renumber an RF or RNF. Never reuse a retired number. Take the next free number; leave the holes.
- Edit wording that leaves the built behaviour identical. Retire the code when the behaviour changes and open a new one.
- Ask the user before retiring. Move a retired code to `### Retired` in `docs/SPEC.md` §1 with its text, date and
  successor. Keep its tick.

## Git

- Enforced by hooks in `.claude/settings.json`: no `git stash`, commits as `wilson <cxrkeybwp2004@gmail.com>`, no Claude
  trailer of any kind, PRs to `integracion`, no `pkill -f`, no `gh pr merge` chained with a delete, no push to `main`.
- Do git work without asking: commit, push, open a PR, merge into `integracion`, delete a branch; report it. Ride a docs
  change along with the work that produced it.
- Ask before taking `integracion` to `main`. That merge is the deploy: once per slice, at most once a day.
- Fetch before you compare. Ask GitHub whether a branch landed: a squash merge is never an ancestor.

## Verification
- `npm run typecheck` is tsgo, `npm run lint` is eslint cached. Both take seconds. Run them freely.
- Size the proof by what the change reaches:
  - A pure function, or a file nothing imports yet: `typecheck`, `lint`, `check:unit` and its own tests.
  - A query or a server action: add every `check:*` that imports it. Grep the importers; in doubt, run them all.
  - A screen: its own specs and the specs the plan names. The whole e2e suite runs in CI, never locally.
- Chase a red with the one spec that failed and the server log. Never by repeating the suite.
- Stub every paid model in a test, a check and a CI job. No proof calls OpenAI or spends a key. Decided by the user
  2026-10-15: «no me gusta eso de que los tests gastan dinero».
- The rest: `docs/agentes/verificacion.md`.

## Writing skills, agents and this file

- Command in verbs. Cut the rationale. Cut every sentence that does not change what someone does.
- List. Never paragraph. State the rule. Avoid the conditional.
- Put a rule where its reader loads it: here only what every agent needs; the rest in `docs/agentes/`, an app's
  `AGENTS.md` or a skill. Put its measurement in `docs/agentes/historia.md`.
- Keep this file at 120 lines or fewer.
