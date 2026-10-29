# WordBook (`apps/wordbook`): auth, `/cuenta` and the census

Read it before driving WordBook, probing its auth or opening a voyager lane. Say its first rule in every dispatch
that drives the app. The why: `docs/agentes/historia.md` § WordBook.

## `/cuenta`

- Never type an address into `/cuenta`. It sends a real email through the user's own Gmail and mints a real
  `auth.users` row, whatever the domain.
- Invite an address: `npm run allow-email -w apps/wordbook -- <correo>`, with `MIGRATION_DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set. It also creates the address's Auth user, confirmed, without sending an email. Never through `/cuenta`.
- Never mutate the deliverability guard in `app/actions/account.ts` while a spec submits that form. With the guard on,
  a dead domain is refused before Supabase; with it off, the same spec sends for real. Prove the guard bites by
  calling `isDomainDeliverable` directly, never by disabling it and driving the screen.

## Auth and the census

- Clean up in the same script that probes `auth` from `apps/wordbook`. It has no harness registry, so `harness:census`
  cannot see its rows and `harness:reap` cannot prune them.
- Read `auth.users` directly when you suspect a `/cuenta` row. The census matches `harness%@example.invalid` and null
  emails only.
- Run `harness:census` from the main checkout in a lane opened with `--app wordbook`: it copies no `apps/homefund/.env.local`.

## Keys and shared tables

- Leave `apps/wordbook/.env.local` alone. It is gitignored, never ships, and its keys are not rotated on an agent's
  initiative. Do not raise it again.
- Copy it unchanged into a lane that runs voyager's suites, as `worktree.sh --app wordbook` does. Never edit it, never
  commit it.
- Never run two agents that write `reading.word_texts` or spend `reading.model_spend` at once. `HARNESS_LANE` does not
  scope them, and two honest reports then contradict each other.
- Read `npx vercel env ls production --project wordbook` before believing a slice shipped. The paid routes answer 204
  when a key is missing, so a dark feature looks like a working one.

## Contract

- `docs/wordbook/SPEC.md`. Its `RL` and `RNL` codes share no number with the finances `RF`/`RNF` series.
