import { applyEntries, readEntries, readReviewSync, writeReviewSync, type ReviewSyncState } from "../review/store";
import { REVIEW_BATCH, type ReviewAnswer, type ReviewRequest, type ReviewWireEntry } from "./review-protocol";

// RL-93: the review's half of a copy round. It rides the record's own request and answer, so a round is still
// one request: `readReviewTrip` says what goes up with it, and `landReviewAnswer` merges what comes back.
export type ReviewTrip = { readerId: string; request: ReviewRequest; sent: ReviewWireEntry[]; state: ReviewSyncState };

// The versions made since the last round and the cursor of what is already merged. A review the copy has not
// met for this reader starts over: everything goes up, nothing is known down. Null when there is nothing to
// ask of: no IndexedDB, or one that does not answer; the record's copy never waits on the review's own database.
export async function readReviewTrip(readerId: string): Promise<ReviewTrip | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const stored = await readReviewSync();
    const state: ReviewSyncState = stored.readerId === readerId ? stored : { readerId, pushedThrough: -1, cursor: null };
    const sent = (await readEntries())
      .filter((entry) => entry.at > state.pushedThrough)
      .sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1))
      .slice(0, REVIEW_BATCH);
    return { readerId, request: { entries: sent, since: state.cursor }, sent, state };
  } catch {
    return null;
  }
}

// Merges the account's page in full before either cursor moves: a round that half lands is read again, not
// skipped. `more` asks the driver for another round while either side filled a page. A full account kept nothing
// of what was sent, so `pushedThrough` stays and the same versions go up next time.
export async function landReviewAnswer(trip: ReviewTrip, answer: ReviewAnswer | null): Promise<{ pulled: number; more: boolean }> {
  if (answer === null) return { pulled: 0, more: false };
  const pulled = await applyEntries(answer.entries);
  const kept = answer.full ? trip.state.pushedThrough : (trip.sent.at(-1)?.at ?? trip.state.pushedThrough);
  await writeReviewSync({ readerId: trip.readerId, pushedThrough: kept, cursor: answer.cursor ?? trip.state.cursor });
  return { pulled, more: (trip.sent.length === REVIEW_BATCH && !answer.full) || answer.entries.length === REVIEW_BATCH };
}
