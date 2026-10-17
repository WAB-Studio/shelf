# M1 · tester · 2026-10-17

Lane 2, branch `codigo6-m1`. Probe: `private/probe-m1-code.mjs` (force-added; the contract says the probe is not
committed; the caller asked for a commit so worker, validator and mutator run the same file; drop it before the merge if
the contract's rule is to hold). Run: `scripts/supabase-local.sh exec node private/probe-m1-code.mjs [u1 u1-hash magic confirmation subject words link]`.
Logs: `private/logs/m1/`.

Behaviours asserted, written from the contract before reading anything else:
- a confirmed address's PKCE send (`@supabase/ssr`, verifier cookie set) mails exactly one six-digit run in Text and HTML;
- a new address's PKCE send (`shouldCreateUser: true`) mails the same;
- that run, given to `verifyOtp({ email, token, type: "email" })` from a client without the verifier, returns a session for that address;
- the code serves once (the board's «sirve una sola vez»);
- the subject is `Tu código para entrar: <the code>` on both mails;
- HTML and Text hold the board's four lines, in the board's order around the code; «entrar con este enlace» is the verify link's anchor;
- both parts keep the verify link `…/auth/v1/verify?token=pkce_…&type=…&redirect_to=<app>/auth/confirm`.

## U1 (measured, without restarting the stack)

**Yes.** On the shared stack (gotrue v2.197.0), a code from a PKCE send verifies with `verifyOtp({ email, token, type: "email" })`,
for a confirmed address (magic-link mail) and for a new one (confirmation mail), from a client holding no verifier, and a second
verify of the same code is refused (`otp_expired`). Log: `private/logs/m1/u1-hash.log`.

How, since today's templates carry no `{{ .Token }}`: the real PKCE send's link token is `pkce_` + hex(sha224(email + otp)),
the otp `{{ .Token }}` renders; the probe (`u1-hash`) searches the 10^6 six-digit codes for that hash, finds one (so the
length is 6 today), and verifies it. Killed by verifying the code plus one (`PROBE_WRONG_CODE=1`): red, log
`private/logs/m1/u1-hash-mutant-wrong-code.log`. After the restart, clause `u1` measures the same thing from the code the mail shows.

## Tests

All in `private/probe-m1-code.mjs`.

| Check | Behaviour |
|---|---|
| `U1 · the send is PKCE` | the send leaves a `*-code-verifier` cookie in the jar, so the code below is a PKCE send's |
| `U1 · the mail shows one six-digit code` / `Magic-link mail carries the code` | confirmed address → one six-digit run in Text and one in HTML, the same digits (links removed first) |
| `Magic-link mail: its code signs that address in (PKCE send)` | that run → `verifyOtp` → `session` and `user.email === address` |
| `U1 · verifyOtp(...) signs that address in`, `U1 · the code serves once` | same, plus a second verify fails |
| `Confirmation mail carries the code` + `its code signs that address in` | new address, `shouldCreateUser: true` → same match and same sign-in |
| `<kind>: Subject is «Tu código para entrar: <code>»` | D7, both mails |
| `<kind>: HTML/Text holds the board's four lines` | heading, «Escríbelo…una sola vez.», «¿Lo pediste…navegador.», «Si no lo pediste tú, ignora este correo.» |
| `<kind>: HTML/Text keeps the board's order` | heading < code < «Escríbelo» < link line < «Si no lo pediste» |
| `<kind>: «entrar con este enlace» is the verify link's anchor` | D1: the anchor's href is `…/auth/v1/verify?…` |
| `<kind>: HTML/Text carries the PKCE verify link to …/auth/confirm` | token starts `pkce_`, type in {signup, magiclink, email}, `redirect_to` is the app's `/auth/confirm` |
| `U1 · the send's code is six digits` (`u1-hash`) | the link token's hash comes from a six-digit code |

Red on today's code: `private/logs/m1/done-red-today.log`, 17 FAIL, 5 PASS (the PKCE-send check and the four link checks, which
the contract wants to hold as today).

Two choices the worker must know:
- The six-digit match runs over the parts with every URL and `href` removed: the verify token is hex, and a 56-char hex hash
  holds a run of exactly six digits about half the time, so the contract's bare regex would flake.
- Auth writes Text itself from the HTML (measured: dashed heading, anchors as `label ( url )`); no template can set it. The
  Text checks remove `( url )` before matching the words, and the link check finds the bare URL there. The code must be
  plain contiguous digits in the HTML (letter-spacing by CSS, never by spaces), or Text and HTML lose the match.

## Mutations

The templates and `otp_length` load only when the stack starts, and the stack is shared: no template mutation can run until
the main session restarts it. Every template row below is red today, before the worker; the mutator applies its mutation after the restart.

| Test | Mutation that kills it | Red output |
|---|---|---|
| U1 (`u1-hash`) | verify the recovered code + 1 (`PROBE_WRONG_CODE=1`) | `FAIL  U1 · verifyOtp({ email, token, type: 'email' }) signs that address in — error otp_expired Token has expired or is invalid` (both addresses) |
| Magic-link mail carries the code | delete `{{ .Token }}` from `magic-link.html` | not run (needs the restart). Today: `FAIL  Magic-link mail carries the code — Text [], HTML []` |
| Confirmation mail carries the code | delete `{{ .Token }}` from `confirmation.html`, or drop `[auth.email.template.confirmation]` | not run (needs the restart). Today: `FAIL  Confirmation mail carries the code — Text [], HTML []` |
| The code is six digits and signs in | `otp_length = 8` (the six-run match fails, then nothing verifies) | not run (needs the restart) |
| Subject | change the subject in `config.toml` | not run. Today: `FAIL  Magic-link mail: Subject is «Tu código para entrar: <code>» — Subject "Your sign-in link", code null` |
| Board words / order / anchor | drop or reorder a line; make the anchor `{{ .SiteURL }}` | not run. Today: `FAIL  … HTML holds the board's four lines — missing [...]`, `FAIL  … «entrar con este enlace» is the verify link's anchor — no such anchor` |
| Link as today | swap `{{ .ConfirmationURL }}` for `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email` (no `/auth/v1/verify`, no `pkce_`) | not run; green today, as the contract wants |

## Uncovered

- **Expiry (`otp_expiry = 3600`).** Read, not driven (an hour cannot be waited); asserting over `config.toml`'s text is forbidden to me. The validator reads it against D8's dashboard value.
- **The six mailpit readers stay green.** Existing suites (`homefund/e2e/sign-in.spec.ts`, `homefund/e2e/invite.spec.ts`,
  `homefund/scripts/check-rls.ts`, `goallog/e2e/entrar-invitacion.spec.ts`, `goallog/scripts/check-allow-email.ts`,
  `wordbook/scripts/check-allow-email.ts`). They mean nothing before the restart, since the stack still sends the old mail; run them after.
- **«The code alone on its line, large, letter-spaced, bold», and the muted last line.** Styling; no server-side check
  states it. Left to the validator's eye on the mailpit HTML.
- **U4 (`content_path` resolution).** Proven by the probe going green after the restart, not before.

## Deferred

- If the main session wants the mutations run before the shared restart: a private `gotrue` container on another port, against
  the same DB and mailpit with the template env set, would load the templates without touching the shared stack. It skips the
  CLI's `config.toml` handling (U4), so it complements the post-restart run and does not replace it.
