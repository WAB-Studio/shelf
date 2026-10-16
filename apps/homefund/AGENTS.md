<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# HomeFund (`apps/orbit`)

Contract: `docs/SPEC.md` §1, model and invariants §2, stack §4. Flows: `docs/FLOWS.md`. Design: `docs/DESIGN.md`.

- Keep this app's `.env.local` here, not at the root.
- Append an assertion at the end of its suite in `scripts/check-queries.ts` and `scripts/check-http.ts` alike. `Q` and
  `H` count calls at runtime; inserting in the middle renumbers everything below.
- Run the RNF-09 timing (`check:http`, `check:queries` with `HARNESS_DATABASE=remote`) alone.
