import type { Sense } from "@/lib/dictionary/index-build";
import type { WordAnswer } from "@/lib/dictionary/lookup";

import type { SenseChoice } from "./store";

// The senses a card can draw from: the headword's own, else the first lemma an inflection reached.
export function answerSenses(answer: WordAnswer): readonly Sense[] {
  return answer.exact?.senses ?? answer.viaInflection[0]?.group.senses ?? [];
}

export function senseChoiceFor(key: string, sense: Sense): SenseChoice {
  return { key, pos: sense.pos, translation: sense.translations[0] ?? "" };
}

// RL-78 and RL-85: a card shows one sense. It is the one the reader tapped in the answer; with no tap,
// or when no sense answers to the one tapped, the headword's first.
export function pickSense(senses: readonly Sense[], choice: SenseChoice | null): Sense | null {
  if (senses.length === 0) return null;
  if (choice !== null) {
    const tapped = senses.find((sense) => sense.pos === choice.pos && (sense.translations[0] ?? "") === choice.translation);
    if (tapped !== undefined) return tapped;
  }
  return senses[0];
}
