import type { Sense } from "@/lib/dictionary/index-build";

// The module 27 wire schema and the row this fills agree on the same 120.
const TRANSLATION_MAX_CHARS = 120;
const TRANSLATION_MAX_SENSES = 3;
const SEPARATOR = ", ";

// Ends at the last whole translation that fits; a single translation over the
// cap ends at the last space before it. Adds no ellipsis.
export function cutTranslation(text: string): string {
  if (text.length <= TRANSLATION_MAX_CHARS) return text;
  const atSeparator = text.lastIndexOf(SEPARATOR, TRANSLATION_MAX_CHARS);
  if (atSeparator > 0) return text.slice(0, atSeparator);
  const atSpace = text.lastIndexOf(" ", TRANSLATION_MAX_CHARS);
  return text.slice(0, atSpace > 0 ? atSpace : TRANSLATION_MAX_CHARS);
}

// The first three senses, in order; a translation said twice keeps its first place.
export function formatSenseTranslations(senses: readonly Sense[]): string {
  const unique = new Set(
    senses.slice(0, TRANSLATION_MAX_SENSES).flatMap((sense) => sense.translations),
  );
  return cutTranslation([...unique].join(SEPARATOR));
}

// A stored line back into its translations: the senses joined them with the same separator.
export function splitTranslations(text: string): string[] {
  return text.split(SEPARATOR).filter((part) => part !== "");
}

// The translations a reader sees before asking for the rest.
export const TRANSLATIONS_SHOWN = 3;

// The first `TRANSLATIONS_SHOWN`, and how many wait behind «ver más».
export function previewTranslations(items: readonly string[]): { shown: string[]; hidden: number } {
  return { shown: items.slice(0, TRANSLATIONS_SHOWN), hidden: Math.max(0, items.length - TRANSLATIONS_SHOWN) };
}
