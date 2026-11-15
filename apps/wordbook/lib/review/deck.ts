import type { StudyRow } from "@/lib/log/summary";

import { isLearning, LEARN_AHEAD_MS, localDay, type ReviewCard } from "./schedule";

// New entries a day can bring in, so a long record never buries the reader on the first visit. Fixed
// at 20 (RL-68): no setting moves it.
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
  // New entries the daily cap held back: the finished screen says how many wait for tomorrow.
  newWaiting: number;
};

type QueueItem = ReviewQueue["items"][number];

// Where an entry stands in the session at `now`: a learning step already due first, the earliest first;
// then whatever else can be asked, in the order it came; then what still waits for its minute, the earliest
// first. A new entry never jumps a learning step that is due.
function sessionRank({ card }: QueueItem, now: number): 0 | 1 | 2 {
  if (card === null || card.due > now) return card === null ? 1 : 2;
  return isLearning(card) ? 0 : 1;
}

export function orderSession(items: readonly QueueItem[], now: number): QueueItem[] {
  return items
    .map((item, position) => ({ item, position, rank: sessionRank(item, now) }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.rank !== 1) return a.item.card!.due - b.item.card!.due || a.position - b.position;
      return a.position - b.position;
    })
    .map(({ item }) => item);
}

/**
 * Today's review: the words already learning whose time came, the earliest first, then as many new
 * words as today's cap leaves, the most looked up first. A learning step due within the learn-ahead
 * (RL-91) is in it too, to be asked when its minute comes. A card whose word left the record is skipped.
 */
export function buildQueue(rows: StudyRow[], cards: ReviewCard[], now: number): ReviewQueue {
  const byKey = new Map(cards.map((card) => [card.key, card]));
  const reviewable = rows.filter(isReviewable);
  const known = reviewable.filter((row) => byKey.has(row.key)).map((row) => ({ row, card: byKey.get(row.key)! }));
  const asked = (card: ReviewCard) => card.due <= now || (isLearning(card) && card.due <= now + LEARN_AHEAD_MS);
  const due = known.filter(({ card }) => asked(card));
  const today = localDay(now);
  const live = new Set(reviewable.map((row) => row.key));
  const introducedToday = cards.filter((card) => card.introducedOn === today && live.has(card.key)).length;
  const unseen = reviewable
    .filter((row) => !byKey.has(row.key))
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
  const fresh = unseen.slice(0, Math.max(0, NEW_PER_DAY - introducedToday)).map((row) => ({ row, card: null }));
  const waiting = known.filter(({ card }) => !asked(card)).map(({ card }) => card.due);
  return {
    items: orderSession([...due, ...fresh], now),
    later: known.length - due.length,
    nextDue: waiting.length === 0 ? null : Math.min(...waiting),
    newWaiting: unseen.length - fresh.length,
  };
}

/**
 * The queue again, from the record and the cards as the device holds them now, for a session already under
 * way (RL-91): `answered` are the entries it has put away, which the finished screen counts itself, so they
 * leave `later`; `total` is every distinct entry the session has asked or still has to.
 */
export function resumeQueue(
  rows: StudyRow[],
  cards: ReviewCard[],
  now: number,
  answered: readonly string[],
): { queue: ReviewQueue; total: number } {
  const queue = buildQueue(rows, cards, now);
  const asking = new Set(queue.items.map(({ row }) => row.key));
  const held = new Set(cards.map((card) => card.key));
  const away = rows.filter((row) => isReviewable(row) && held.has(row.key) && !asking.has(row.key) && answered.includes(row.key)).length;
  return {
    queue: { ...queue, later: queue.later - away },
    total: new Set([...answered, ...asking]).size,
  };
}

/**
 * One entry on demand, from the panel of its history: due or not, it is asked now. Nothing of the day's
 * queue, and it takes no slot of the daily cap (the session rates it with an empty `introducedOn`). Empty
 * when the record holds no answer for it.
 */
export function buildQueueFor(rows: StudyRow[], cards: ReviewCard[], key: string, now: number): ReviewQueue {
  const row = rows.find((candidate) => (candidate.key === key || candidate.key.toLowerCase() === key.toLowerCase()) && isReviewable(candidate));
  if (row === undefined) return { items: [], later: 0, nextDue: null, newWaiting: 0 };
  const card = cards.find((candidate) => candidate.key === row.key) ?? null;
  return {
    items: [{ row, card: card === null ? null : { ...card, due: Math.min(card.due, now) } }],
    later: 0,
    nextDue: null,
    newWaiting: 0,
  };
}
