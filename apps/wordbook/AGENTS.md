<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# WordBook (`apps/wordbook`)

Contract: `docs/wordbook/SPEC.md`. Design: `docs/wordbook/DESIGN.md`. Read `docs/agentes/wordbook.md` before driving
this app, probing its auth or touching its keys.

- Run specs with `VOYAGER_BASE_URL=http://localhost:310<n-1>`. Its Playwright ignores `HARNESS_BASE_URL`; a lane that sets only that hits :3100.
- Never type an address into `/cuenta`: it sends a real email and mints a real `auth.users` row.
- Never disable the deliverability guard in `app/actions/account.ts` to prove it; call `isDomainDeliverable` directly.
- Leave `.env.local` alone: never edit, commit or rotate it.
