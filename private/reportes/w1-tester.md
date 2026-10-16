# W1 tester

Branch `wordbook-w1`. Tests written from the plan's contract and Done table; routes read only to learn names and import paths.
Red logs: `private/logs/w1-dark-red.log`, `private/logs/w1-lib-red.log`. Mutation logs: `private/logs/w1-m*.log`, patches `private/m*.patch`.
Result: 64 + 11 = 75 tests; 53 red now (45 in api-dark, 8 in the lib files), 22 green guards for «answers unchanged». All reds are assertion
diffs (or the missing `dark`/`responses` modules), not harness crashes. `typecheck` fails only on the two modules not yet built.

## Tests
- `apps/wordbook/scripts/api-dark.test.ts` (per route: word/text, word/unlisted, phrase/notes, 17 tests each + shared):
  - no key -> 204, empty body, no-store, exactly `[["[paid-dark]", route, "no-key"]]`, nothing claimed.
  - each cap unset (text 1, unlisted 2, notes 3) -> `no-cap`.
  - no chargeable caller -> `no-caller`, no claims.
  - share refused -> `caller-share`, caller and day claims 0. Caller cap refused -> `caller-cap`, day claim 0. Day cap -> `day-cap`.
  - each of the three claims throwing -> `claim-error`, and `console.error` still holds the error.
  - cache read throws -> `cache-error` + console.error kept. Model null -> `model-failed`.
  - cache write throws -> 200, no dark line, console.error kept. Inside every cap -> 200, silent. Cache hit with no key -> 200, silent.
  - invalid JSON, bad shape, foreign Origin (403), text/plain (415) with no key -> no warn at all.
  - every line is compared whole and scanned for the word, phrase, hash, caller key and `sk-test`.
  - 400 bodies unchanged; headword outside the dictionary and a listed unlisted word -> 400 silent.
  - text enrichment of a cached thin row refused for each of 7 reasons -> 200 with cached text, no model call, one line with the reason; enriched inside caps and non-thin/asked rows -> silent.
  - RL-45: `surface`/`rule` on a full word reaches the model with `senses === null` (as without); an unknown rule still parses (200); a thin word still gets its senses.
  - log/sync and log/clear: 401, 400, 409, 200 all `no-store`, bodies as today.
- `apps/wordbook/lib/account/sign-in-budget.test.ts` (6): no salt / no caller -> `noKey`, one `signin no-caller` line, 0 claims; ok and both rateLimited paths silent; line leaks neither address, salt nor key.
- `apps/wordbook/lib/word/dark.test.ts` (2): `logDark` writes exactly one `console.warn("[paid-dark]", route, reason)` and nothing else; loaded with no `server-only` stub.
- `apps/wordbook/lib/http/responses.test.ts` (3): `NO_STORE`, `json`, `empty` (status, empty body, header); no `server-only` stub, so the module may not import it.

## Mutations
The worker has not run, so a red test's «mutation» is the unbuilt feature itself (shown red above). Green guards were each killed against the current source
(apply, run the one test with `--test-name-pattern`, `git apply -R`; every one went `fail 1`):

| Test | Mutation | Red |
|---|---|---|
| text/unlisted/notes cache write fails -> 200 | `return empty(204)` after the write catch's console.error (m1 text:175, m2 unlisted:141, m3 notes:147) | fail 1 each |
| text bad body/403/415 silent; unlisted; notes | `console.warn("[paid-dark]"...)` before the parse (m4 text:58, m19 unlisted:41, m20 notes:55) | fail 1 each |
| inside every cap silent (text, unlisted, notes) | warn before the 200 (m5, m15, m16) | fail 1 each |
| cache hit silent (text, unlisted, notes) | warn on the hit (m6, m17, m18) | fail 1 each |
| thin word keeps its senses | `thin ? group.senses : null` -> `null` (m7) | fail 1 |
| log/sync no-store | `NO_STORE = {}` in sync (m9) | fail 1 |
| unknown headword 400 silent / unlisted exact 400 silent | warn on those branches (m11, m12) | fail 1 each |
| enriched inside caps / no enrichment needed silent | warn before enrichment (m10) | fail 1 |
| 400 bodies unchanged | unlisted `empty(400)` -> json (m8); text `json` -> `empty(400)` (m22); notes (m23) | fail 1 each |
| sign-in ok / caller rateLimited silent | warn before `return "ok"` (m13), before the caller rateLimited (m14) | fail 1 each |

Red-now rows (45 + 8) fail with deep-equal diffs of `[]` against the expected line, `400 !== 200` for the unknown rule, and «a surface/rule claim made a full word thin».
After the worker, the plan's mutations apply to them (delete the logDark in a branch, swap claims, etc.).
The `drop headers from empty()` mutation can only be run once `lib/http/responses.ts` exists.

## Uncovered
- The two greps (`const NO_STORE` 0, RL-45 grep 3 lines): asserting over source text is forbidden; `responses.test.ts` and the route tests cover the behaviour.
- «Existing tests green, unedited», `check:thinness` (needs the flip of `<= 4`), `check:sync`, `check:sign-in-budget`: run by the worker's verification, not new tests.
- Enrichment generation returning null (translations null): the contract does not name a reason there; not asserted.
- Claim-order swaps are covered by claim counts (share 1 / caller 0 / day 0), not by call-order spies.
- `/api/translate` is W2's.

## Deferred
- The existing `api-spend-caps.test.ts` mocks `groupFor` for every word, so it cannot drive RL-45's claim path; my surface/rule tests use a per-word `groupFor`.
