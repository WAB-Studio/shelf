## Done
- docs/wordbook/SPEC.md: one "Open, 2026-10-16" line under RL-01, 07, 08, 10, 12, 27, RNL-02, 03, 07; §3 `(RL-20)` -> `(RL-65)`. No tick added: none had every clause driven.
- CI base: run 38922132767 (integracion, a8ae7de9) success incl. voyager-e2e and unit.
- Lint: private/w7-lint.txt (clean).
- Per code (clauses driven / undriven):
  - RL-01: types->answers driven (e2e/word.spec.ts:141); focus on open and thumb reach undriven.
  - RL-07: positive e2e/word.spec.ts:227; negative e2e/phrase.spec.ts:87 asserts right after fill, before the settle (vacuous).
  - RL-08: network path + RL-11 at phrase.spec.ts:138; on-device ("available", originDevice) undriven.
  - RL-10: "downloading" / downloadingModel never driven.
  - RL-12: fetch once/install e2e/install.spec.ts:15; progress shown only asserted absent (sin-red-una-visita.spec.ts:158,184).
  - RL-27: queries scripts/mcp/aggregate.test.ts:40,67,76,85; server.ts untested.
  - RNL-02: no test of "no literal strings"; lib/catalog.test.ts checks quoting only.
  - RNL-03: 360 overflow/44px (word.spec.ts:141, bottom-nav.spec.ts:103), column at 1280 (escritorio.spec.ts:56); overlap undriven, 1440 not tested.
  - RNL-07: no toggle built (app/theme.css prefers-color-scheme only).
## Why
- Zero ticks: contract says tick only when every clause has a driving test; none qualified.
- No trailer added despite the session reminder: AGENTS.md and the assignment forbid it.
## Questions
none
## Unresolved
none
## Deferred
Tests for the undriven clauses (RL-08/10 via a faked Translator, RL-12 progress, RL-01 focus) belong to a tester slice.
