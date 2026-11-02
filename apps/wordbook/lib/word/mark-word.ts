import { lemmaCandidates } from "@/lib/dictionary/inflect";

export type Piece = { text: string; hit: boolean };

// A lemma shorter than this is matched as written: «a», «I» and «be» would otherwise hit «and», «it» and «been»; a three-letter lemma keeps to its regular endings below.
const MIN_INFLECTED_LENGTH = 4;

const VOWEL = /[aeiou]/;

// A short lemma is matched through the endings no other word shares: «-s», «-ing», and the doubled endings of a
// consonant-vowel-consonant lemma (`run`, `running`, `hopped`). «-ed», «-d», «-es» and «-ly» are left out: the
// resolver's looser rules would let «hop» mark «hoping» (that is «hope»), «car» «cared», «ear» «early».
function isRegularForm(lemma: string, token: string): boolean {
  if (token === `${lemma}s`) return true;
  const last = lemma.at(-1) ?? "";
  const doubles = !VOWEL.test(lemma[0]) && VOWEL.test(lemma[1]) && !VOWEL.test(last) && !"wxy".includes(last);
  if (doubles) return token === `${lemma}${last}ed` || token === `${lemma}${last}ing`;
  return token === `${lemma}ing`;
}

function isFormOf(token: string, forms: ReadonlySet<string>): boolean {
  const lower = token.toLowerCase();
  if (forms.has(lower)) return true;
  return lemmaCandidates(lower).some(({ lemma }) => {
    if (!forms.has(lemma)) return false;
    return lemma.length >= MIN_INFLECTED_LENGTH || (lemma.length === 3 && isRegularForm(lemma, lower));
  });
}

// A phrase cut around the word to set it apart: a token hits when it is one of the forms the word was
// searched under, or an inflection the resolver traces back to one of them (`bleaker` to `bleak`).
export function splitAroundWord(text: string, forms: readonly string[]): Piece[] {
  const wanted = new Set(forms.map((form) => form.trim().toLowerCase()).filter((form) => form !== ""));
  if (wanted.size === 0) return [{ text, hit: false }];
  const pieces: Piece[] = [];
  let from = 0;
  for (const match of text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu)) {
    if (!isFormOf(match[0], wanted)) continue;
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
