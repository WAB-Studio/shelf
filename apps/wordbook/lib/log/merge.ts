import { isPendingLookup } from "./outcome";
import { openLogDatabase } from "./record";
import type { LookupRecord } from "./types";

// The account copy's two operations on `lookups` (RL-55, RL-24, RNL-09), kept
// out of record.ts so the write path a keystroke rides never gains a
// function it does not call.

const STORE_NAME = "lookups";

// Measured at ~141 KB per request at 289 bytes/row (lib/sync/protocol.ts):
// a batch this size never ties the store up long enough to delay
// `recordLookup`'s own `add`.
const BATCH_SIZE = 500;
// A main-thread task issues at most this many `add`s or reads: a task of
// 500 averaged 7 ms, long enough to hold a search behind it.
const CHUNK = 50;

/** A row another device recorded, on its way into this one's copy (RL-24). */
export type ForeignRow = Omit<LookupRecord, "id" | "device" | "deviceSeq"> & {
  device: string;
  deviceSeq: number;
};

/**
 * Rows above `afterLocalId`, in key order, at most `limit` of them. `own` is
 * the local ones, less every pending row: one stays on its device (RL-76) and
 * travels later as the new row its answer mints. `scannedThrough` is the `id`
 * of the last row read, foreign or pending or not, so the caller moves past them.
 */
export async function readSince(
  afterLocalId: number,
  limit: number,
): Promise<{ own: LookupRecord[]; scannedThrough: number | null; scanned: number }> {
  const database = await openLogDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const page: LookupRecord[] = [];
    const next = (after: number, open: boolean) => {
      const request = store.getAll(IDBKeyRange.lowerBound(after, open), Math.min(CHUNK, limit - page.length));
      request.onsuccess = () => {
        const got = request.result as LookupRecord[];
        page.push(...got);
        if (got.length === CHUNK && page.length < limit) return next(got[got.length - 1].id!, true);
        resolve({
          own: page.filter((row) => row.device == null && !isPendingLookup(row)),
          scannedThrough: page.length > 0 ? page[page.length - 1].id! : null,
          scanned: page.length,
        });
      };
      request.onerror = () => reject(request.error);
    };
    if (limit <= 0) return resolve({ own: [], scannedThrough: null, scanned: 0 });
    next(afterLocalId, true);
  });
}

// One batch's worth of `add` calls, each row's `ConstraintError` swallowed —
// the unique index on `[device, deviceSeq]` is what makes a repeat merge a
// no-op — and counted instead of aborting the rest of the batch.
function mergeBatch(database: IDBDatabase, batch: ForeignRow[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    let inserted = 0;
    const addChunk = (from: number) => {
      const slice = batch.slice(from, from + CHUNK);
      slice.forEach((row, index) => {
        const request = store.add(row);
        const last = index === slice.length - 1 && from + CHUNK < batch.length;
        request.onsuccess = () => {
          inserted += 1;
          if (last) addChunk(from + CHUNK);
        };
        request.onerror = (event) => {
          if (request.error?.name === "ConstraintError") {
            event.preventDefault();
            if (last) addChunk(from + CHUNK);
          }
        };
      });
    };
    addChunk(0);
    transaction.oncomplete = () => resolve(inserted);
    // A row's own `preventDefault()` above only cancels the abort; the
    // "error" event still bubbles here, with the transaction unharmed. Only
    // an unhandled error — one no row's own `onerror` swallowed — aborts it.
    transaction.onabort = () => reject(transaction.error);
  });
}

/**
 * Merges foreign rows in batches of `BATCH_SIZE`, `CHUNK` rows per task,
 * never one transaction for the whole set — that would tie up `lookups` for
 * its entire duration and delay `recordLookup`'s own writes. Idempotent per row via the `foreign`
 * index, not all-or-nothing per call (RL-13's guarantee does not apply
 * here): a batch that lands stays landed, and an interrupted merge resumes
 * from wherever the cursor last advanced. Returns how many rows actually
 * entered.
 */
export async function mergeForeign(rows: ForeignRow[]): Promise<number> {
  const database = await openLogDatabase();
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    inserted += await mergeBatch(database, batch);
  }
  return inserted;
}
