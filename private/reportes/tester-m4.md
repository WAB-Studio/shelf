## Tests
`apps/homefund/lib/validation/auth.test.ts` (10 tests, node:test): padded address -> lowercase trimmed; tab/newline; upper-case; "" and "   " one issue on email with auth.errors.emailInvalid; "not-an-address", "a@b"; non-string (42, null) carries the key; missing email refused; code schema accepts padded address; code schema refuses "a@b" with same key; both schemas agree on padding/case.

Baseline on current source (red): 4 fail (1, 2, 8, 10), 6 pass (refusals already hold). Log: private/m4-red-baseline.log.

## Mutations
Applied over a temporary fixed schema (all 10 green), then restored to the original. Log: private/m4-mutations.log.
| Mutation | Red |
|---|---|
| format first `z.email().trim()` | 1, 2, 8, 10 |
| `.replace(/^ +\| +$/g,"")` | 2, 10 |
| drop `.toLowerCase()` | 1, 3, 8, 10 |
| `.optional()` | 7 (missing email; "" still refused by optional, so the table's "empty" row is killed by 4 only under the min(1) mutation) |
| `z.string().min(1)` no pipe | 4, 5, 9 |
| `z.string()` without `error` | 6 |
| code schema own `z.email()` | 8, 10 |

## Uncovered
Action/form wiring (`app/actions/auth.ts`, login-form): not edited, no e2e in this lane.

## Deferred
Mutation `.optional()` does not red the "empty" test; that is expected (zod optional only admits undefined).
