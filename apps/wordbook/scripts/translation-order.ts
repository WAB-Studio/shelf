import { readFileSync } from "node:fs";
import path from "node:path";

import type { RawEntry } from "../lib/dictionary/format";

// Articles, prepositions, pronouns and conjunctions: they say nothing about how common a translation is.
const FUNCTION_WORDS = new Set(
  (
    "el la los las un una unos unas lo al del de a en con por para sin sobre entre hasta desde hacia contra " +
    "y e o u ni que si como cuando donde se me te le les nos os mi tu su sus mis tus este esta esto ese esa eso " +
    "algo alguien uno una cual cuyo no ya muy más menos"
  ).split(" "),
);

const COMMON = new Set(
  readFileSync(path.join(import.meta.dirname, "spanish-frequency.txt"), "utf8").split("\n").filter(Boolean),
);

// Common: one of its content words is among the list's 20,000 commonest. A translation made only of
// function words is common. Absent from the list means rank 20,000 or below, or not Spanish subtitles at all.
export function isCommonTranslation(translation: string): boolean {
  const tokens = translation.toLowerCase().match(/\p{L}+/gu) ?? [];
  const content = tokens.filter((word) => !FUNCTION_WORDS.has(word));
  return content.length === 0 ? tokens.length > 0 : content.some((word) => COMMON.has(word));
}

// Demotion only: the dictionary's order stands, and a translation the list does not vouch for moves behind
// the rest, keeping its own order there. Nothing is ever promoted over a sibling.
export function demoteRareTranslations(translations: readonly string[]): string[] {
  return [...translations.filter(isCommonTranslation), ...translations.filter((t) => !isCommonTranslation(t))];
}

// A gloss the source wraps whole in quotation marks (`"bueno, por lo menos"`) loses them: the screen cuts a
// line between glosses and would leave one quote dangling. Quotes inside a gloss (`hora "peak"`) stay.
export function cleanGloss(gloss: string): string {
  const wrapped = gloss.match(/^["“]([\s\S]*)["”]$/);
  return wrapped !== null && !/["“”]/.test(wrapped[1]) ? wrapped[1].trim() : gloss;
}

const INFINITIVE = /(ar|er|ir|ár|ér|ír|arse|erse|irse)$/u;

// A gloss that is only another gloss of the same list inflected -- `libros` beside `libro` -- or, in a verb's
// entry, a bare first-person form (`digo`, `miento`) where infinitives stand: it names no meaning of its own.
export function isInflectedGloss(gloss: string, siblings: readonly string[], pos: string): boolean {
  if (/\s/u.test(gloss)) return false;
  if (gloss.endsWith("s") && siblings.includes(gloss.slice(0, -1))) return true;
  if (gloss.endsWith("es") && siblings.includes(gloss.slice(0, -2))) return true;
  return pos === "v" && gloss.endsWith("o") && siblings.some((other) => other !== gloss && INFINITIVE.test(other));
}

// Reviewed by hand against the shipped asset: a gloss the source gets wrong (`alegría` for bleak) leaves, and
// the sense a reader means leads. Keyed `headword|pos`.
export const KNOWN_WRONG: Readonly<Record<string, readonly string[]>> = {
  "mean|v": ["intencionar decir", "intencionar"],
  "fair|adj": ["pastel", "viento de popa"],
  "bleak|adj": ["alegría"],
};
export const LEADING: Readonly<Record<string, readonly string[]>> = {
  "mean|v": ["significar", "querer decir"],
  "fair|adj": ["justo", "razonable"],
  "bleak|adj": ["desolado"],
  // The model's pick for `it` (ello) is formal; the reviewed lead is what a speaker says.
  "it|n": ["lo", "eso"],
  "cup|n": ["vaso", "taza"],
};

// The lead translations one offline model pass picked (`pick-translations.ts`), keyed `headword|pos`. Committed
// output only: the build reads it and never asks a model.
const PICKS = JSON.parse(readFileSync(path.join(import.meta.dirname, "translation-picks.json"), "utf8")) as Readonly<
  Record<string, readonly string[]>
>;

// Frequency demotion first (the dictionary's order stands), then the inflected forms of a sibling go last, then
// the lead: the one a person reviewed, which outranks the model, else the model's picks.
export function rankTranslations(headword: string, pos: string, translations: readonly string[]): string[] {
  const key = `${headword.toLowerCase()}|${pos}`;
  const wrong = KNOWN_WRONG[key] ?? [];
  const kept = translations.filter((gloss) => !wrong.includes(gloss));
  const ranked = demoteRareTranslations(kept);
  const plain = ranked.filter((gloss) => !isInflectedGloss(gloss, kept, pos));
  const ordered = [...plain, ...ranked.filter((gloss) => isInflectedGloss(gloss, kept, pos))];
  const reviewed = (LEADING[key] ?? []).filter((gloss) => ordered.includes(gloss));
  const lead = reviewed.length > 0 ? reviewed : (PICKS[key] ?? []).filter((gloss) => ordered.includes(gloss));
  return [...lead, ...ordered.filter((gloss) => !lead.includes(gloss))];
}

export function orderEntryTranslations(entry: RawEntry): RawEntry {
  const [headword, pos, ipa, translations, definition] = entry;
  const cleaned = [...new Set(translations.map(cleanGloss))];
  return [headword, pos, ipa, rankTranslations(headword, pos, cleaned), definition];
}
