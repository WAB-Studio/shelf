import type { Sense } from "@/lib/dictionary/index-build";
import type { WordAnswer } from "@/lib/dictionary/lookup";

import { splitTranslations } from "@/lib/log/translation-line";

// The senses a card can draw from: the headword's own, else the first lemma an inflection reached.
export function answerSenses(answer: WordAnswer): readonly Sense[] {
  return answer.exact?.senses ?? answer.viaInflection[0]?.group.senses ?? [];
}

// RL-78: a card shows one sense. It is the sense the reader saw, the one sharing the most
// translations with the line the record kept; with none in common, the headword's first.
export function pickSense(senses: readonly Sense[], stored: string | null): Sense | null {
  if (senses.length === 0) return null;
  const kept = new Set(stored === null ? [] : splitTranslations(stored));
  let best = senses[0];
  let bestScore = best.translations.filter((translation) => kept.has(translation)).length;
  for (const sense of senses.slice(1)) {
    const score = sense.translations.filter((translation) => kept.has(translation)).length;
    if (score > bestScore) {
      best = sense;
      bestScore = score;
    }
  }
  return best;
}
