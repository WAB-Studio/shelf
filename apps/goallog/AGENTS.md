<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# GoalLog (`apps/goallog`)

Contract: `docs/goallog/SPEC.md`. Design: `docs/goallog/DESIGN.md`. CI and mutations: `docs/agentes/verificacion.md`.

- Run specs with `PULSAR_BASE_URL=http://localhost:320<n-1>`. Its Playwright ignores `HARNESS_BASE_URL`.
- Run a spec that needs `PULSAR_FAULT_BASE_URL` (`mes-todas.spec.ts:183` and kin) beside a fault server:
  `PULSAR_FAULT_PORT=<free port> npm run start:fault` here, then point `PULSAR_FAULT_BASE_URL` at it. Without it the
  spec is red for no reason.
- Drive mutations against `next build` + `next start`, never `next dev`, never `rm -rf .next`.
- Run a new spec under `pulsar-e2e`, fired on its branch, before calling it green.
