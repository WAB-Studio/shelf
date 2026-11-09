import type { Sense } from "@/lib/dictionary/index-build";
import type { WordAnswer } from "@/lib/dictionary/lookup";

import type { SenseChoice } from "./store";

// The senses a card can draw from: the headword's own, else the first lemma an inflection reached.
export function answerSenses(answer: WordAnswer): readonly Sense[] {
  return answer.exact?.senses ?? answer.viaInflection[0]?.group.senses ?? [];
}

function signatureOf(sense: Sense): string {
  return JSON.stringify([sense.pos, sense.translations, sense.definition]);
}

export function senseChoiceFor(key: string, senses: readonly Sense[], sense: Sense): SenseChoice {
  return { key, index: senses.indexOf(sense), signature: signatureOf(sense) };
}

// RL-78 and RL-85: a card shows one sense. It is the one the reader tapped in the answer; with no tap,
// or when no sense answers to the one tapped, the headword's first.
export function pickSense(senses: readonly Sense[], choice: SenseChoice | null): Sense | null {
  if (senses.length === 0) return null;
  if (choice !== null) {
    const atIndex = senses[choice.index];
    if (atIndex !== undefined && signatureOf(atIndex) === choice.signature) return atIndex;
    const tapped = senses.find((sense) => signatureOf(sense) === choice.signature);
    if (tapped !== undefined) return tapped;
  }
  return senses[0];
}
