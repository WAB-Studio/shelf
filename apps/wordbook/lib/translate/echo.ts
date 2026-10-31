// Trim, case-fold, and drop whitespace and punctuation — the differences a
// reader never notices between what they typed and what came back. MyMemory
// appends a full stop to a string it echoes, so punctuation cannot count.
export function foldForComparison(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// MyMemory echoes a string it cannot place in either language straight
// back — gibberish included — with `responseStatus: "200"` and no warning.
// The same fold also refuses a proper noun, a brand name or a number that
// legitimately holds still across `en` and `es`; RL-59's per-word breakdown
// is what that reply lands on instead, an honest "could not answer".
export function isEcho(source: string, translated: string): boolean {
  const folded = foldForComparison(source);
  return folded.length > 0 && foldForComparison(translated) === folded;
}
