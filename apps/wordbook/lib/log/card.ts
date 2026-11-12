import type { StudyRow } from "./summary";

/**
 * The card's front, repeating the registro's rule: a phrase or an unlisted
 * word reached no lemma and keeps the text as typed; every other group shows
 * its lemma.
 */
export function cardFront(row: StudyRow): string {
  return row.lastOutcome === "translated" || row.lastOutcome === "unlisted" ? row.display : row.key;
}

/**
 * The card's back as the review draws it when no sense answers (RL-72): the logged translation, else the
 * network's definition; `null` when the group has neither.
 */
export function cardBack(row: StudyRow): string | null {
  return row.lastTranslation ?? row.lastDefinition;
}
