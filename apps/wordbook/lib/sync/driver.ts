import type { ForeignRow } from "@/lib/log/merge";
import { readSince, mergeForeign } from "@/lib/log/merge";
import { applyTombstones, readTombstoneQueue, settleTombstones } from "@/lib/log/delete";
import { markRetired, readSyncState, writeSyncState } from "@/lib/log/record";
import { SYNC_BATCH, syncRequestSchema, syncResponseSchema, type SyncResponse, type SyncRow, type Tombstone } from "./protocol";
import { failureCause, type SyncFailure } from "./failure";
import { shareInFlight } from "./in-flight";
import { planUploadRound } from "./upload-page";

const SYNC_ENDPOINT = "/api/log/sync";
export const SYNC_LOCK = "voyager-sync";

// A hostile record can never tie a hidden tab up forever: this many round
// trips per call, then the rest waits for the next hide.
const MAX_BATCHES = 40;

export const SYNC_LANDED_EVENT = "voyager:sync-landed";

class SyncFailureError extends Error {
  constructor(readonly cause: SyncFailure) {
    super(`sync failed: ${cause}`);
  }
}

export type SyncOutcome =
  | { kind: "off" } // enabled === false: no request was ever issued
  | { kind: "done"; pushed: number; pulled: number }
  | { kind: "retired" } // the server retired this device: the copy is off for good
  | { kind: "reader" } // the session belongs to another reader: the identity is dropped, the copy must be confirmed again
  | { kind: "failed"; cause: SyncFailure };

// The row's own device, not this one's: it already crossed the wire once.
// Every other wire field passes through, so a new one needs no edit here.
function toForeignRow(row: SyncResponse["rows"][number]): ForeignRow {
  const { deviceId, localId, recordSchema, receivedAt, ...rest } = row;
  void receivedAt;
  return { ...rest, schema: recordSchema, device: deviceId, deviceSeq: localId };
}

// Hands the main thread back so a search typed meanwhile runs between the
// parse and the merge, not after them.
const yieldToLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// `deviceId` travels on every round, `rows` empty or not: a pull-only round
// still has to seal this device's own row in `reading.devices` (module 31,
// RL-25), and the route has nothing else top-level to read it off.
async function postBatch(
  deviceId: string,
  readerId: string,
  rows: SyncRow[],
  since: string | null,
  tombstones: Tombstone[],
  tombstonesSince: string | null,
): Promise<SyncResponse | "retired" | "reader"> {
  const response = await fetch(SYNC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(syncRequestSchema.parse({ deviceId, readerId, rows, since, tombstones, tombstonesSince })),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    if (response.status === 409 && body?.error === "retired") return "retired";
    if (response.status === 409 && body?.error === "reader") return "reader";
    throw new SyncFailureError(failureCause({ status: response.status, body }));
  }
  return syncResponseSchema.parse(await response.json());
}

// Keeps the cursors: with no reader on record they read as another reader's,
// so the next confirm starts past every stored row and uploads none of them.
async function dropIdentity(): Promise<SyncOutcome> {
  await writeSyncState({ enabled: false, readerId: null });
  return { kind: "reader" };
}

/**
 * Pushes local rows and pulls foreign ones, in batches of `SYNC_BATCH`, until
 * both sides come back short or `MAX_BATCHES` is spent. Every round calls
 * `postBatch`, even one with nothing local to push: the download is not a
 * side effect of the upload, so a fresh device with an empty log still pulls
 * what the account already holds. Never throws: a failed round trip leaves
 * the cursors where they were, so the next call resumes it.
 */
async function runSyncLocked(): Promise<SyncOutcome> {
  const state = await readSyncState();
  if (!state.enabled) return { kind: "off" };
  // A copy with no reader on record cannot say whose searches it holds.
  if (!state.readerId) return dropIdentity();

  let pushedThroughLocalId = state.pushedThroughLocalId;
  let pulledThroughCursor = state.pulledThroughCursor;
  let pushed = 0;
  let pulled = 0;
  let removed = 0;

  try {
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const { own, scannedThrough, scanned } = await readSince(pushedThroughLocalId ?? 0, SYNC_BATCH);
      const { rows } = planUploadRound(own, state.deviceId);
      // Read every round, not once per call: a page sent leaves the queue
      // shorter, and a delete made meanwhile joins it.
      const queue = await readTombstoneQueue(state.readerId);
      const marks = queue.pending.slice(0, SYNC_BATCH);
      const response = await postBatch(state.deviceId, state.readerId, rows, pulledThroughCursor, marks, queue.since);
      if (response === "retired") {
        await markRetired();
        return { kind: "retired" };
      }
      if (response === "reader") return dropIdentity();

      // The merge is awaited in full before either cursor moves: a batch
      // that only half lands must be read again next time, not skipped.
      await yieldToLoop();
      pulled += await mergeForeign(response.rows.map(toForeignRow));
      // Marks are applied after the merge, so a row and the mark that deletes
      // it in one answer never leave the row behind. The queue settles only
      // once both landed: a round that fails before keeps every mark for the
      // next one. A null mark cursor means none came back, never "start over".
      removed += await applyTombstones(response.tombstones, state.deviceId);
      await settleTombstones(state.readerId, marks, response.tombstoneCursor ?? queue.since);

      // The upload cursor follows what was scanned, not what was sent: a page
      // of foreign rows has nothing to send and still has to be left behind.
      if (scannedThrough !== null) pushedThroughLocalId = scannedThrough;
      pushed += rows.length;
      pulledThroughCursor = response.cursor;
      await writeSyncState({ pushedThroughLocalId, pulledThroughCursor, lastSyncedAt: Date.now() });
      await yieldToLoop();

      // Stop only once neither side has a next page waiting: a short scanned
      // page alone no longer ends the call, or a large foreign backlog would
      // never finish downloading behind a thin local log.
      const marksWaiting = response.tombstones.length >= SYNC_BATCH || queue.pending.length > marks.length;
      if (scanned < SYNC_BATCH && response.rows.length < SYNC_BATCH && !marksWaiting) break;
    }
    if (pulled > 0 || removed > 0) window.dispatchEvent(new Event(SYNC_LANDED_EVENT));
    return { kind: "done", pushed, pulled };
  } catch (error) {
    const cause =
      error instanceof SyncFailureError
        ? error.cause
        : failureCause({ error, online: typeof navigator === "undefined" || navigator.onLine });
    return { kind: "failed", cause };
  }
}

// One tab syncs at a time: a second tab's round reads the row the first has
// just written. Without Web Locks the in-flight share still covers one realm.
function runSync(): Promise<SyncOutcome> {
  if (typeof navigator === "undefined" || !navigator.locks) return runSyncLocked();
  return navigator.locks.request(SYNC_LOCK, runSyncLocked).then((outcome) => outcome);
}

export const syncNow = shareInFlight(runSync);
