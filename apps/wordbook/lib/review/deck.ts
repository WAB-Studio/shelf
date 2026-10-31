import type { StudyRow } from "@/lib/log/summary";

import { localDay, type ReviewCard } from "./schedule";

// New entries a day can bring in, so a long record never buries the reader on the first visit.
export const NEW_PER_DAY = 20;

// An entry with an answer to recall: a word or a translated phrase (RL-78). A row still waiting for its
// answer (RL-76), a phrase that never translated or a word the dictionary never answered has nothing on
// its back.
export function isReviewable(row: StudyRow): boolean {
  if (row.pending === true) return false;
  if (row.lastOutcome === "untranslated" || row.lastOutcome === "miss") return false;
  return row.lastTranslation !== null || row.lastDefinition !== null;
}

export type ReviewQueue = {
  items: { row: StudyRow; card: ReviewCard | null }[];
  // Cards waiting later today or beyond: what the finished screen names.
  later: number;
};

/**
 * Today's review: the words already learning whose time came, the earliest first, then as many new
 * words as today's cap leaves, the most looked up first. A card whose word left the record is skipped.
 */
export function buildQueue(rows: StudyRow[], cards: ReviewCard[], now: number): ReviewQueue {
  const byKey = new Map(cards.map((card) => [card.key, card]));
  const reviewable = rows.filter(isReviewable);
  const known = reviewable.filter((row) => byKey.has(row.key));
  const due = known
    .map((row) => ({ row, card: byKey.get(row.key)! }))
    .filter(({ card }) => card.due <= now)
    .sort((a, b) => a.card.due - b.card.due);
  const today = localDay(now);
  const live = new Set(reviewable.map((row) => row.key));
  const introducedToday = cards.filter((card) => card.introducedOn === today && live.has(card.key)).length;
  const fresh = reviewable
    .filter((row) => !byKey.has(row.key))
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, Math.max(0, NEW_PER_DAY - introducedToday))
    .map((row) => ({ row, card: null }));
  return { items: [...due, ...fresh], later: known.length - due.length };
}
