// What a person's own movements teach about a counterparty's category (RF-210). It is read from the
// movements themselves, never kept in a table of its own, so accepting a proposal under another category
// and editing a movement's category both teach it with no extra step. It is pure: no DB, no async.

// Two movements are the whole vote. One agreeing pair is evidence (the same bar RF-94 sets for a merchant);
// a single movement counts only when it is the only history; a disagreeing pair is no answer, and the next
// movement that agrees with the newer one settles it again, so unlike an `ambiguous` merchant it recovers.
const AGREEMENT = 2;

// How far back the lookup reads. Rent and yearly subscriptions repeat inside it; a counterparty last seen
// longer ago says little about today.
export const LEARNED_WINDOW_MONTHS = 24;

// A key shorter than this names no one («a», «d»); one longer is a whole message, which would match every
// message from one bank that names no counterparty.
export const LEARNED_KEY_MIN_LENGTH = 3;
export const LEARNED_KEY_MAX_LENGTH = 60;

// The categories of the counterparty's most recent movements, newest first; only the first two vote.
export function agreedCategory(recent: readonly string[]): string | null {
  const voters = recent.slice(0, AGREEMENT);
  if (voters.length === 0) return null;

  return voters.every((categoryId) => categoryId === voters[0]) ? voters[0] : null;
}

// A history-learned proposal is stored with the source `merchant` (the counterparty's memory) and no
// trusted merchant behind it: the source's CHECK has no value of its own for it, and a trusted merchant
// always states its own.
export function categoryFromHistory(delivery: {
  categorySource: string | null;
  merchantState: "learning" | "trusted" | "ambiguous" | null;
}): boolean {
  return delivery.categorySource === "merchant" && delivery.merchantState !== "trusted";
}
