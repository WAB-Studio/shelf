import type { Tombstone } from "@/lib/sync/protocol";
import { openLogDatabase } from "./record";
import type { LookupRecord, SyncState } from "./types";
import { deleteCard } from "../review/store";

// Deleting a `/registro` row (RL-66, device half) and the marks other devices
// made (RL-70). No request leaves from here (RNL-09): the queue waits in the
// `sync` store for the next round the existing triggers start.

const STORE_NAME = "lookups";
const SYNC_STORE_NAME = "sync";
const QUEUE_KEY = "tombstones";

// `history-list.tsx` rereads on it, as it does on `LOG_CLEARED_EVENT`.
export const LOG_DELETED_EVENT = "voyager:log-deleted";

// The queue's one row beside `state`: tagged with its reader, so a device that
// switches reader never sends the first one's marks under the second's session.
type QueueRow = { key: typeof QUEUE_KEY; readerId: string; pending: Tombstone[]; since: string | null };

const markKey = (mark: Tombstone) => JSON.stringify([mark.deviceId, mark.localId]);

function asPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Attached before the first request: a transaction that aborts while the
// caller still awaits a read must not reject a promise nobody holds.
function completion(transaction: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  done.catch(() => undefined);
  return done;
}

// Another reader's queue reads as empty, cursor included.
function queueFor(row: QueueRow | undefined, readerId: string): QueueRow {
  return row?.readerId === readerId ? row : { key: QUEUE_KEY, readerId, pending: [], since: null };
}

/**
 * The ids a `/registro` row holds and the marks that name them. The group is
 * `summary.ts`'s own key, `headword ?? normalised`, never `readLemmaHistory`'s
 * union: a row typed `leave` that reached `leaf` belongs to `leaf`'s row.
 */
export function planGroupDelete(
  rows: readonly LookupRecord[],
  key: string,
  ownDeviceId: string,
): { ids: number[]; tombstones: Tombstone[] } {
  const ids: number[] = [];
  const tombstones: Tombstone[] = [];
  for (const row of rows) {
    if ((row.headword ?? row.normalised) !== key || row.id === undefined) continue;
    ids.push(row.id);
    tombstones.push(
      row.device ? { deviceId: row.device, localId: row.deviceSeq! } : { deviceId: ownDeviceId, localId: row.id },
    );
  }
  return { ids, tombstones };
}

/**
 * Deletes a `/registro` row's searches in one transaction with the queue, so
 * a refused commit leaves both as they were. Marks are queued only for a
 * reader on record: with none, there is no account copy to delete from.
 */
export async function deleteStudyGroup(key: string): Promise<{ deleted: number }> {
  const database = await openLogDatabase();
  const transaction = database.transaction([STORE_NAME, SYNC_STORE_NAME], "readwrite");
  const done = completion(transaction);
  const lookups = transaction.objectStore(STORE_NAME);
  const sync = transaction.objectStore(SYNC_STORE_NAME);
  const [byHeadword, byNormalised, state, queue] = await Promise.all([
    asPromise(lookups.index("headword").getAll(key) as IDBRequest<LookupRecord[]>),
    asPromise(lookups.index("normalised").getAll(key) as IDBRequest<LookupRecord[]>),
    asPromise(sync.get("state") as IDBRequest<SyncState | undefined>),
    asPromise(sync.get(QUEUE_KEY) as IDBRequest<QueueRow | undefined>),
  ]);
  // A row whose headword and normalised are both the key comes back twice.
  const candidates = new Map<number, LookupRecord>();
  for (const row of [...byHeadword, ...byNormalised]) candidates.set(row.id!, row);
  const plan = planGroupDelete([...candidates.values()], key, state?.deviceId ?? "");
  for (const id of plan.ids) lookups.delete(id);
  if (state?.readerId && plan.tombstones.length > 0) {
    const current = queueFor(queue, state.readerId);
    // A set keyed on the pair, so the merge costs one visit per mark.
    const seen = new Set(current.pending.map(markKey));
    const fresh = plan.tombstones.filter((mark) => {
      const markId = markKey(mark);
      if (seen.has(markId)) return false;
      seen.add(markId);
      return true;
    });
    sync.put({ ...current, pending: [...current.pending, ...fresh] } satisfies QueueRow);
  }
  await done;
  await deleteCard(key).catch(() => undefined);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LOG_DELETED_EVENT));
  return { deleted: plan.ids.length };
}

/** This reader's queued marks and mark cursor; another reader's read as none. */
export async function readTombstoneQueue(readerId: string): Promise<{ pending: Tombstone[]; since: string | null }> {
  const database = await openLogDatabase();
  const store = database.transaction(SYNC_STORE_NAME, "readonly").objectStore(SYNC_STORE_NAME);
  const { pending, since } = queueFor(await asPromise(store.get(QUEUE_KEY) as IDBRequest<QueueRow | undefined>), readerId);
  return { pending, since };
}

/**
 * Drops the marks a round delivered and stores the mark cursor it returned.
 * Reads the queue inside its own transaction: a mark queued while the round
 * was in flight stays for the next one.
 */
export async function settleTombstones(readerId: string, sent: Tombstone[], cursor: string | null): Promise<void> {
  const database = await openLogDatabase();
  const transaction = database.transaction(SYNC_STORE_NAME, "readwrite");
  const done = completion(transaction);
  const store = transaction.objectStore(SYNC_STORE_NAME);
  const current = queueFor(await asPromise(store.get(QUEUE_KEY) as IDBRequest<QueueRow | undefined>), readerId);
  const delivered = new Set(sent.map(markKey));
  const pending = current.pending.filter((queued) => !delivered.has(markKey(queued)));
  store.put({ ...current, pending, since: cursor } satisfies QueueRow);
  await done;
}

/**
 * Removes the rows other devices' marks name, and counts them. An own mark
 * names a row this device recorded, by `id`, never a pulled one that shares
 * the number; a foreign mark goes through the `foreign` index. Queues nothing:
 * the account already holds these marks.
 */
export async function applyTombstones(marks: Tombstone[], ownDeviceId: string): Promise<number> {
  if (marks.length === 0) return 0;
  const database = await openLogDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const done = completion(transaction);
  const store = transaction.objectStore(STORE_NAME);
  const foreign = store.index("foreign");
  const found = await Promise.all(
    marks.map(async (mark) => {
      if (mark.deviceId !== ownDeviceId) {
        return asPromise(foreign.getKey([mark.deviceId, mark.localId])) as Promise<IDBValidKey | undefined>;
      }
      const row = await asPromise(store.get(mark.localId) as IDBRequest<LookupRecord | undefined>);
      return row && row.device == null ? mark.localId : undefined;
    }),
  );
  // Two marks can name one row; it is removed, and counted, once.
  const ids = new Set(found.filter((id): id is IDBValidKey => id !== undefined));
  for (const id of ids) store.delete(id);
  await done;
  return ids.size;
}
