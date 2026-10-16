// The stable key `ingest_counterparties` (Module 5, RF-135) learns an account
// against — a normalised span of a statement-row description, not an SMS. Kept
// out of `lib/ingest/fingerprint.ts` on purpose: that file's mask feeds a shape
// hash with its own stability clause, for a different source. It is pure: no
// DB, no async, no side effect.

// A token is masked only when it carries no letter at all — an amount
// (`$150.000`), a date (`05/09/2026`) or a bare reference tail (`883921`).
// A token kept, case folded, in full, digits included: `D1` is a supermarket
// chain, `4x1000` is the GMF tax's own name (`private/analisis/analisis-
// nequi-lulo.md:648-653` records it as a literal, invariant description
// across the corpus), and masking either would erase the word that names the
// counterparty or the charge, not a reference number. Consequence: a trailing
// named span is never masked away. `RECARGA DESDE` (no name yet) and
// `RECARGA DESDE: RUSHBET` (a name) must stay two keys — folding them into
// one would let a single RUSHBET payout teach the pattern for every unrelated
// `RECARGA DESDE` row, marking two dozen legitimate rows ambiguous for good.
//
// The trade this buys: `REF883921` carries a letter, so it survives whole and
// gives every row bearing it its own key — the pattern never reaches two
// agreeing completions and learns nothing. That is the safe failure. Erasing
// a digit-bearing name so two different counterparties share one key is the
// unsafe one: RF-135 marks a pattern `ambiguous` on a second disagreement and
// no later agreement undoes it, so a collision here poisons the key for good.
// Learning nothing beats learning wrong.
const HAS_LETTER = /\p{L}/u;

const NOT_WORD_CHARACTER = /[^\p{L}\p{N}]+/gu;

const MASK = "#";

export function counterpartyPatternKey(description: string): string {
  const parts: string[] = [];

  for (const rawToken of description.trim().split(/\s+/)) {
    const token = rawToken.replace(NOT_WORD_CHARACTER, "");
    if (token.length === 0) {
      continue;
    }

    if (!HAS_LETTER.test(token)) {
      // Adjacent masked tokens collapse into one, so a two-digit reference and
      // an eight-digit account tail reach the same key.
      if (parts[parts.length - 1] !== MASK) {
        parts.push(MASK);
      }
      continue;
    }

    parts.push(token.toLowerCase());
  }

  return parts.join(" ");
}
