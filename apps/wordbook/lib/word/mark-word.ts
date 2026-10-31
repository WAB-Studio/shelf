export type Piece = { text: string; hit: boolean };

function escape(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A phrase cut around the forms of one word, to set the word apart. A form also matches with up to
// three letters after it (`bleak` in «bleaker», `run` in «running»), and never inside a longer word.
export function splitAroundWord(text: string, forms: readonly string[]): Piece[] {
  const usable = [...new Set(forms.map((form) => form.trim()).filter((form) => form !== ""))].sort((a, b) => b.length - a.length);
  if (usable.length === 0) return [{ text, hit: false }];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${usable.map(escape).join("|")})\\p{L}{0,3}(?![\\p{L}\\p{N}])`, "giu");
  const pieces: Piece[] = [];
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > from) pieces.push({ text: text.slice(from, match.index), hit: false });
    pieces.push({ text: match[0], hit: true });
    from = match.index + match[0].length;
  }
  if (from < text.length) pieces.push({ text: text.slice(from), hit: false });
  return pieces.length === 0 ? [{ text, hit: false }] : pieces;
}

// The phrase with every hit replaced by a gap, for a card that asks the reader to recall the word.
export function gapOutWord(text: string, forms: readonly string[], gap = "_____"): string {
  return splitAroundWord(text, forms)
    .map((piece) => (piece.hit ? gap : piece.text))
    .join("");
}
