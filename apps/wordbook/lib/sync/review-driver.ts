import { applyEntries, readEntries, readReviewSync, writeReviewSync, type ReviewSyncState } from "../review/store";
import { failureCause, type SyncFailure } from "./failure";
import { SYNC_BATCH } from "./protocol";
import { reviewSyncRequestSchema, reviewSyncResponseSchema } from "./review-protocol";

// RL-93: the review's half of a copy round. It runs after the record's own, under the same lock, and
// answers in the same terms.
const REVIEW_ENDPOINT = "/api/review/sync";

// A hostile review can never tie a hidden tab up forever: this many round trips per call.
const MAX_BATCHES = 40;

export type ReviewOutcome =
  | { kind: "done"; pulled: number }
  | { kind: "reader" } // the session belongs to another reader
  | { kind: "failed"; cause: SyncFailure };

// Sends up the versions made since the last round and merges down the ones the account holds that the
// cursor has not passed, until both sides come back short. Never throws: a failed round trip leaves the
// cursors where they were, so the next call resumes it.
export async function syncReview(readerId: string, timeoutMs: number): Promise<ReviewOutcome> {
  // A browser with no IndexedDB has no review to copy; the record's own round already said what it could.
  if (typeof indexedDB === "undefined") return { kind: "done", pulled: 0 };
  try {
    const stored = await readReviewSync();
    // A review the copy has not met for this reader starts over: everything goes up, nothing is known down.
    let state: ReviewSyncState = stored.readerId === readerId ? stored : { readerId, pushedThrough: -1, cursor: null };
    let pulled = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const entries = (await readEntries())
        .filter((entry) => entry.at > state.pushedThrough)
        .sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1))
        .slice(0, SYNC_BATCH);
      const response = await fetch(REVIEW_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(reviewSyncRequestSchema.parse({ readerId, entries, since: state.cursor })),
      });
      // No session: nothing to copy to, and the record's round, which needs one, has already answered.
      if (response.status === 401) return { kind: "done", pulled };
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        if (response.status === 409 && body?.error === "reader") return { kind: "reader" };
        return { kind: "failed", cause: failureCause({ status: response.status, body }) };
      }
      const answer = reviewSyncResponseSchema.parse(await response.json());
      // Merged in full before either cursor moves: a round that half lands is read again, not skipped.
      pulled += await applyEntries(answer.entries);
      state = {
        readerId,
        pushedThrough: entries.length > 0 ? entries[entries.length - 1].at : state.pushedThrough,
        cursor: answer.cursor ?? state.cursor,
      };
      await writeReviewSync(state);
      if (entries.length < SYNC_BATCH && answer.entries.length < SYNC_BATCH) break;
    }
    return { kind: "done", pulled };
  } catch (error) {
    return { kind: "failed", cause: failureCause({ error, online: typeof navigator === "undefined" || navigator.onLine }) };
  }
}
