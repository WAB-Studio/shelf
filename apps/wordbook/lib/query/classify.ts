import { normaliseHeadword } from "@/lib/dictionary/format";

export type QueryKind =
  | { kind: "empty" }
  | { kind: "word"; text: string }
  | { kind: "phrase"; text: string; tokens: number };

// Fewer tokens than this is a word.
// Two, not three. A two-word query that is not itself an entry is almost
// always a phrasal verb — "toiling up", "give in", "look after" — whose
// meaning is precisely not the sum of its parts, so the word-by-word
// breakdown is the one answer that cannot help. Translating costs nothing
// worth counting: the device's own translator is free, and MyMemory's
// anonymous tier caps at ~5,000 words a day against two words a query.
export const PHRASE_MIN_TOKENS = 2;

// A string above this is still a phrase; the module that refuses to send it
// over the network is the one that reads this number.
export const PHRASE_MAX_TOKENS = 60;

// The box takes a word or a sentence and never asks which (RL-02). The whole
// string is tried against the dictionary before it is ever counted in
// tokens, so a multi-word headword like "give up" answers as a word (RL-03).
export function classify(raw: string, isEntry: (normalised: string) => boolean): QueryKind {
  const text = raw.trim().replace(/\s+/g, " ");
  if (text === "") {
    return { kind: "empty" };
  }
  if (isEntry(normaliseHeadword(text))) {
    return { kind: "word", text };
  }
  const tokens = text.split(" ").length;
  if (tokens >= PHRASE_MIN_TOKENS) {
    return { kind: "phrase", text, tokens };
  }
  return { kind: "word", text };
}
