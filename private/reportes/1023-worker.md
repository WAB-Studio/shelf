## Done
- apps/pulsar/lib/auth/allowlist.ts (new): `isEmailAllowed`, one `select exists(...)` through `db`, lower(btrim()).
- app/actions/account.ts: `notInvited` check after schema, before DNS and Auth.
- app/auth/confirm/route.ts: `code` branch (verifier cookie check -> linkOtherBrowser; `exchangeCodeForSession` once via verifyMagicLink); `token_hash` branch unchanged.
- lib/auth/verify-magic-link.ts: FailureReason adds `linkOtherBrowser`.
- eslint.config.mjs: allowlist.ts joins the db/client allowed files.
- messages/es/account.json: notInvited, linkOtherBrowserTitle/Body.
- components/account/entrar-screen.tsx (not in the file list): `linkOtherBrowser` added to LINK_ERRORS, otherwise the redirect shows nothing.
Verification: typecheck green; lint 0 errors (3 old warnings); check:unit 1502/1502 (private/out/1023-unit.txt, 1023-lint.txt); e2e entrar.spec 6/6 (private/out/1023-e2e-entrar.txt); mcp confirm-next green (private/out/1023-confirm-next.txt).
## Why
- Verifier presence read from request cookies ending `-code-verifier`: no Auth call without it.
- Reused verifyMagicLink for the exchange so timeout/invalid mapping and single call stay shared.
## Questions
none
## Unresolved
- Form's rendering of `notInvited` relies on the generic `errors.<key>` lookup (typecheck green); not driven in a browser (no e2e for it).
## Deferred
none
