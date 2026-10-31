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

export function orderEntryTranslations(entry: RawEntry): RawEntry {
  const [headword, pos, ipa, translations, definition] = entry;
  const cleaned = [...new Set(translations.map(cleanGloss))];
  return [headword, pos, ipa, demoteRareTranslations(cleaned), definition];
}
