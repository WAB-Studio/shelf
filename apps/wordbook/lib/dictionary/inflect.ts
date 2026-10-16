import { normaliseHeadword } from "./format";
import { IRREGULAR_FORMS } from "./irregular-forms";

// Ordered by decreasing confidence: a table lookup beats a guess, and a
// guess that changes fewer letters beats one that changes more.
export type InflectionRule =
  | "identity"
  | "irregular"
  | "plural-s"
  | "plural-es"
  | "plural-ies"
  | "past-ed"
  | "past-ied"
  | "past-doubled"
  | "ing"
  | "ing-e"
  | "ing-doubled"
  | "comparative"
  | "superlative"
  | "adverb-ly"
  | "possessive";

export type LemmaCandidate = { lemma: string; rule: InflectionRule };

const MAX_CANDIDATES = 12;

function isConsonant(ch: string): boolean {
  return /^[bcdfghjklmnpqrstvwxz]$/.test(ch);
}

// A suffix strip that would leave no stem at all is not a candidate.
function stripSuffix(word: string, suffix: string): string | undefined {
  if (word.length <= suffix.length || !word.endsWith(suffix)) return undefined;
  return word.slice(0, word.length - suffix.length);
}

// "stopp" -> "stop", "runn" -> "run". Declines a core that is not doubled.
function undouble(core: string): string | undefined {
  if (core.length < 2) return undefined;
  const last = core[core.length - 1];
  if (last !== core[core.length - 2] || !isConsonant(last)) return undefined;
  const stem = core.slice(0, -1);
  return stem.length > 0 ? stem : undefined;
}

function pluralS(word: string): LemmaCandidate[] {
  const stem = stripSuffix(word, "s");
  return stem ? [{ lemma: stem, rule: "plural-s" }] : [];
}

function pluralEs(word: string): LemmaCandidate[] {
  const stem = stripSuffix(word, "es");
  return stem ? [{ lemma: stem, rule: "plural-es" }] : [];
}

function pluralIes(word: string): LemmaCandidate[] {
  const stem = stripSuffix(word, "ies");
  return stem ? [{ lemma: stem + "y", rule: "plural-ies" }] : [];
}

function pastEd(word: string): LemmaCandidate[] {
  const candidates: LemmaCandidate[] = [];
  const dropped = stripSuffix(word, "ed");
  if (dropped) candidates.push({ lemma: dropped, rule: "past-ed" });
  // "loved" drops only the "d": the stem's own "e" was already there.
  if (word.endsWith("ed")) {
    const kept = stripSuffix(word, "d");
    if (kept) candidates.push({ lemma: kept, rule: "past-ed" });
  }
  return candidates;
}

function pastIed(word: string): LemmaCandidate[] {
  const stem = stripSuffix(word, "ied");
  return stem ? [{ lemma: stem + "y", rule: "past-ied" }] : [];
}

function pastDoubled(word: string): LemmaCandidate[] {
  const core = stripSuffix(word, "ed");
  if (!core) return [];
  const stem = undouble(core);
  return stem ? [{ lemma: stem, rule: "past-doubled" }] : [];
}

function ing(word: string): LemmaCandidate[] {
  const stem = stripSuffix(word, "ing");
  return stem ? [{ lemma: stem, rule: "ing" }] : [];
}

function ingE(word: string): LemmaCandidate[] {
  const core = stripSuffix(word, "ing");
  return core ? [{ lemma: core + "e", rule: "ing-e" }] : [];
}

function ingDoubled(word: string): LemmaCandidate[] {
  const core = stripSuffix(word, "ing");
  if (!core) return [];
  const stem = undouble(core);
  return stem ? [{ lemma: stem, rule: "ing-doubled" }] : [];
}

function comparative(word: string): LemmaCandidate[] {
  const candidates: LemmaCandidate[] = [];
  const withIer = stripSuffix(word, "ier");
  if (withIer) candidates.push({ lemma: withIer + "y", rule: "comparative" });
  const dropped = stripSuffix(word, "er");
  if (dropped) {
    candidates.push({ lemma: dropped, rule: "comparative" });
    const doubled = undouble(dropped);
    if (doubled) candidates.push({ lemma: doubled, rule: "comparative" });
  }
  // "nicer" drops only the "r": the stem's own "e" was already there.
  if (word.endsWith("er")) {
    const kept = stripSuffix(word, "r");
    if (kept) candidates.push({ lemma: kept, rule: "comparative" });
  }
  return candidates;
}

function superlative(word: string): LemmaCandidate[] {
  const candidates: LemmaCandidate[] = [];
  const withIest = stripSuffix(word, "iest");
  if (withIest) candidates.push({ lemma: withIest + "y", rule: "superlative" });
  const dropped = stripSuffix(word, "est");
  if (dropped) {
    candidates.push({ lemma: dropped, rule: "superlative" });
    const doubled = undouble(dropped);
    if (doubled) candidates.push({ lemma: doubled, rule: "superlative" });
  }
  // "nicest" drops only the "st": the stem's own "e" was already there.
  if (word.endsWith("est")) {
    const kept = stripSuffix(word, "st");
    if (kept) candidates.push({ lemma: kept, rule: "superlative" });
  }
  return candidates;
}

function adverbLy(word: string): LemmaCandidate[] {
  const candidates: LemmaCandidate[] = [];
  const withIly = stripSuffix(word, "ily");
  if (withIly) candidates.push({ lemma: withIly + "y", rule: "adverb-ly" });
  const dropped = stripSuffix(word, "ly");
  if (dropped) candidates.push({ lemma: dropped, rule: "adverb-ly" });
  return candidates;
}

function possessive(word: string): LemmaCandidate[] {
  const stem = stripSuffix(word, "'s");
  return stem ? [{ lemma: stem, rule: "possessive" }] : [];
}

// Every rule the assignment names, applied in the order declared above and
// left to disagree freely: the caller, who knows the dictionary, decides
// which guess was real.
const RULES: ((word: string) => LemmaCandidate[])[] = [
  pluralS,
  pluralEs,
  pluralIes,
  pastEd,
  pastIed,
  pastDoubled,
  ing,
  ingE,
  ingDoubled,
  comparative,
  superlative,
  adverbLy,
  possessive,
];

export function lemmaCandidates(surface: string): LemmaCandidate[] {
  const word = normaliseHeadword(surface);
  const candidates: LemmaCandidate[] = [{ lemma: word, rule: "identity" }];

  for (const lemma of IRREGULAR_FORMS.get(word) ?? []) {
    candidates.push({ lemma, rule: "irregular" });
  }
  for (const rule of RULES) {
    candidates.push(...rule(word));
  }

  const seen = new Set<string>();
  const deduped: LemmaCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.lemma)) continue;
    seen.add(candidate.lemma);
    deduped.push(candidate);
    if (deduped.length === MAX_CANDIDATES) break;
  }
  return deduped;
}
