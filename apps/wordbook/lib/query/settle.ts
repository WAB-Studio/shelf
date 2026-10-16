// RNL-05, rule 1: how long the box waits for a pause before anything past
// the word path is worth asking about — the sentence translation, the URL
// write and the word's own decoration all ride this one pause, so a reader
// sees a single rhythm rather than three slightly different ones.
//
// Lives in `lib/`, not in `search-screen.tsx`, because `lib/word/use-decoration.ts`
// needs the same number and a `lib/` module must never import one back out
// of `components/`.
export const PHRASE_DEBOUNCE_MS = 600;
