## Tests
check-sign-in.ts (appended): (1) count-1 row today + same key other day -> other day's row survives (hf13); (2) another key's count-1 row survives a release (hf16); (3) counts 2 and 5 released -> n-1 and audit_log holds exactly one UPDATE, no DELETE for key/day (hf10); (4) Date faked 2026-10-17T02:00Z -> claimed.day and stored rows are 2026-10-16 (hf08).
sign-in-action.test.ts (appended): release double gated by the test; action unsettled while pending, settled after (hf20).

## Mutations
Logs in private/mut/<patch>.check:{sign-in,unit}.log. Baseline and restored: sign-in 19/0, unit 177/0.
| test | mutant | result |
|---|---|---|
| other-day survives | hf13 | red: not ok 16 |
| other-key survives | hf16 | red: not ok 17 |
| Bogota 21:00 | hf08 | red: not ok 19 |
| action awaits release | hf20 | red: unit not ok 63 |
| hf10 | count >= 1 | survives (green, 0 fails) |

## Uncovered
hf10 is equivalent on the local Postgres: the CTE delete and the outer update target the same row in one statement; Postgres performs only one of two modifications of a row and here the UPDATE wins, so rows at count 2 and 5 end at n-1 with one UPDATE and no DELETE in audit_log (measured by the new test passing under the mutant). Which one wins is unspecified by the docs, so no behaviour on this server tells them apart; not forced with a source assertion.

## Deferred
None.
