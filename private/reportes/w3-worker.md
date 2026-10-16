## Done
- apps/wordbook/lib/word/late-answer.ts (new): LateResult, askLate, remembers, useLateAnswer.
- lib/word/use-decoration.ts, use-network-answer.ts: rewritten on the hook; InflectionClaim and 3rd param gone.
- lib/phrase/use-phrase-notes.ts (new): usePhraseNotes (W4 mounts it).
- lib/dictionary/install.ts, use-dictionary.ts: Error messages in English, reasons unchanged.
- e2e/fixtures.ts: scriptWordRoute / releaseWordRoute (abort, status, ok, hold; STUB_HEADER kept; defaults unchanged).
- Tests first (WIP commit 302458a5): lib/word/late-answer.test.ts, e2e/decoracion-reintento.spec.ts.
- Verification: typecheck+lint clean (private/logs/w3-static.log, w3-lint2.log); check:unit 428/428 (w3-unit.log);
  e2e on :3101 (build+start): decoracion-reintento, word, palabra-de-la-red, palabra-flaca, forma-primero, sin-entrada, install,
  sin-red-una-visita, frase-notas: 105 passed, 2 failed (w3-e2e.log) -- the 2 were my spec's script (apple consumed the 200 step);
  fixed in the spec, rerun 6/6 green (w3-e2e-new.log). Build log w3-build.log.
## Why
- Hook takes the cache as a parameter so each fetcher keeps its own module cache.
- Latest `ask` held in a ref so callers' fresh closures do not retrigger the effect.
- Phrase notes use debounce 0 (a 0ms timer), to keep set-state out of the effect body.
- Spec script includes a 204 step for the intermediate word `apple`.
## Questions
none
## Unresolved
- Only the new spec was rerun after the spec-only fix. components/search/phrase-notes.tsx untouched (W4).
## Deferred
- W4 mounts usePhraseNotes.
