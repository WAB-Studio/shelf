import type { Sense, SenseGroup } from "@/lib/dictionary/index-build";
import { isRareSense } from "@/lib/dictionary/rare-sense";
import type { WordAnswer } from "@/lib/dictionary/lookup";

import type { SenseChoice } from "./store";

// The group a card draws from: the headword's own, else the first lemma an inflection reached.
export function answerGroup(answer: WordAnswer): SenseGroup | null {
  return answer.exact ?? answer.viaInflection[0]?.group ?? null;
}

export function answerSenses(answer: WordAnswer): readonly Sense[] {
  return answerGroup(answer)?.senses ?? [];
}

// A group built by hand carries no flag and reads as ranked.
export function answerRanked(answer: WordAnswer): boolean {
  return answerGroup(answer)?.ranked ?? true;
}

function signatureOf(sense: Sense): string {
  return JSON.stringify([sense.pos, sense.translations, sense.definition]);
}

export function senseChoiceFor(key: string, senses: readonly Sense[], sense: Sense): SenseChoice {
  return { key, index: senses.indexOf(sense), signature: signatureOf(sense) };
}

// RL-91: the sense a reader most plausibly meant. A group the dictionary ranked by real use leads with its
// first sense; one only the fixed fallback ranked (verb before noun) leads with its first common noun
// instead, so `tree` is «árbol» and not «enarbolar».
function defaultSense(senses: readonly Sense[], ranked: boolean): Sense {
  if (ranked || senses[0].pos === "n") return senses[0];
  return senses.find((sense) => sense.pos === "n" && !isRareSense(sense)) ?? senses[0];
}

// RL-78, RL-85 and RL-91: a card shows one sense. It is the one the reader tapped in the answer; with no tap,
// or when no sense answers to the one tapped, the default sense.
export function pickSense(senses: readonly Sense[], choice: SenseChoice | null, ranked = true): Sense | null {
  if (senses.length === 0) return null;
  if (choice !== null) {
    const atIndex = senses[choice.index];
    if (atIndex !== undefined && signatureOf(atIndex) === choice.signature) return atIndex;
    const tapped = senses.find((sense) => signatureOf(sense) === choice.signature);
    if (tapped !== undefined) return tapped;
  }
  return defaultSense(senses, ranked);
}
