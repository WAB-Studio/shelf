import type { SenseGroup } from "@/lib/dictionary/index-build";

// RL-45: a lemma the dictionary carries but barely — too few translations to
// trust alone, and either more than one sense to pick from or no definition
// to fall back on. Over the shipped asset it catches 16.1% of lemmas;
// "≤4 translations" alone would catch 90.0%, so the sense-or-no-definition
// floor is what keeps this from being a second call on nearly every word.
export function isThinAnswer(group: SenseGroup): boolean {
  const translationCount = group.senses.reduce((total, sense) => total + sense.translations.length, 0);
  const hasNoDefinition = group.senses.every((sense) => sense.definition === null);
  return translationCount <= 4 && (group.senses.length >= 2 || hasNoDefinition);
}
