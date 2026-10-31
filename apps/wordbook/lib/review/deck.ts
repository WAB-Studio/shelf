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
  // When the earliest of those comes due, or null with none waiting.
  nextDue: number | null;
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
  const waiting = known.map((row) => byKey.get(row.key)!.due).filter((moment) => moment > now);
  return {
    items: [...due, ...fresh],
    later: known.length - due.length,
    nextDue: waiting.length === 0 ? null : Math.min(...waiting),
  };
}

/**
 * One entry on demand, from the panel of its history: due or not, it is asked now. Nothing of the day's
 * queue, so answering it introduces no other entry. Empty when the record holds no answer for it.
 */
export function buildQueueFor(rows: StudyRow[], cards: ReviewCard[], key: string, now: number): ReviewQueue {
  const row = rows.find((candidate) => candidate.key === key && isReviewable(candidate));
  if (row === undefined) return { items: [], later: 0, nextDue: null };
  const card = cards.find((candidate) => candidate.key === key) ?? null;
  return {
    items: [{ row, card: card === null ? null : { ...card, due: Math.min(card.due, now) } }],
    later: 0,
    nextDue: null,
  };
}
