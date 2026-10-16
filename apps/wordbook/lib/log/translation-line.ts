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
