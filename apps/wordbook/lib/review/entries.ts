import type { ReviewWireEntry } from "../sync/review-protocol";
import type { ReviewCard } from "./schedule";
import type { SenseChoice } from "./store";

// RL-93: what the review keeps for one word, as one version the account's copy can order against another. A
// device holds the halves apart (a card, a sense, a deletion mark); here they meet in the shape that travels.
export type ReviewEntry = ReviewWireEntry;

export type LocalHalves = {
  card: ReviewCard | null;
  choice: SenseChoice | null;
  goneAt: number | null;
};

// The moment a version was made: the last review, the tap or the deletion. A tap kept before its moment was
// recorded counts as 0, which loses to anything.
export function entryOf(key: string, { card, choice, goneAt }: LocalHalves): ReviewEntry | null {
  if (card === null && choice === null) return goneAt === null ? null : { key, at: goneAt, gone: true, card: null, sense: null };
  return {
    key,
    at: Math.max(card?.lastReview ?? 0, choice?.chosenAt ?? 0),
    gone: false,
    card: card && toWireCard(card),
    sense: choice && { index: choice.index, signature: choice.signature, chosenAt: choice.chosenAt ?? 0 },
  };
}

function toWireCard({ key, ...rest }: ReviewCard): NonNullable<ReviewEntry["card"]> {
  void key;
  return rest;
}

export function cardOf(entry: ReviewEntry): ReviewCard | null {
  return entry.card && { key: entry.key, ...entry.card };
}

export function choiceOf(entry: ReviewEntry): SenseChoice | null {
  return entry.sense && { key: entry.key, ...entry.sense };
}

// The version a device holds once `remote` has met `local`, or null when the device's own stands. The later
// moment wins whole; on a tie the device's own stands. The half a newer version lacks is kept from the older,
// and a deletion keeps neither.
export function settle(local: ReviewEntry | null, remote: ReviewEntry): ReviewEntry | null {
  if (local !== null && remote.at <= local.at) return null;
  if (remote.gone || local === null || local.gone) return remote;
  return { ...remote, card: remote.card ?? local.card, sense: remote.sense ?? local.sense };
}
