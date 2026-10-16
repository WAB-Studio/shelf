import { isRecordedOutcome } from "./outcome";
import { countPending } from "./pending";
import { pendingRowFrom } from "./record-text";
import { normaliseSyncState, signOutSyncState, syncStateForReader } from "./sync-state";
import type { LookupRecord, SyncState } from "./types";

// A separate database from `reading-dictionary`: an IndexedDB transaction is
// scoped to one database, so a write here never queues behind a read of the
// 8.2 MB payload (RNL-06).
const DATABASE_NAME = "reading-log";
export const DATABASE_VERSION = 3;
const STORE_NAME = "lookups";
const AT_INDEX = "at";
const SYNC_STORE_NAME = "sync";
const SYNC_KEY = "state";

// The sync store's single row, keyed for `keyPath: "key"`.
type SyncRow = SyncState & { key: typeof SYNC_KEY };

// The box is quiet this long before a query counts as settled.
const SETTLE_MS = 800;

// `localStorage.setItem` is the one storage write the platform guarantees
// finishes before the calling script returns — unlike an IndexedDB
// transaction, which commits on a later task that a document torn down by
// a reload, a URL navigation or history traversal never gets to run. A row
// lands here the instant it is at risk, and is read back the moment the
// next document loads.
//
// Holds a list, not one row: `flushPendingLookup` can call `commit` twice in
// the same synchronous pass — once for the prefix chain's displaced row,
// once for the row that displaced it — and both are at risk from the same
// navigation. A second commit used to overwrite the first's key outright
// before its IndexedDB transaction had a chance to survive the teardown
// (docs/TRAPS.md); the list is what lets both wait out that teardown.
const PENDING_RELAY_KEY = "voyager:pending-log-row";

let databasePromise: Promise<IDBDatabase> | null = null;

// Mirrors `databasePromise` once it resolves, so a caller that cannot afford
// to wait on a promise — a `pagehide` handler gets no later task to resume
// in — can still reach the connection with a plain property read.
let openDatabaseHandle: IDBDatabase | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("indexedDB unavailable"));
  }
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    // No branch here ever reads, writes or deletes a row: versions 1 to 3
    // add stores and indexes, nothing more, so an upgrade cannot lose one.
    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (event.oldVersion < 1) {
        const store = database.createObjectStore(STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("at", "at");
        store.createIndex("normalised", "normalised");
      }
      if (event.oldVersion < 2) {
        database.createObjectStore(SYNC_STORE_NAME, { keyPath: "key" });
        // `undefined` on either component is not a valid key, so this index
        // only ever covers a foreign row: a local one never names a device.
        request.transaction!
          .objectStore(STORE_NAME)
          .createIndex("foreign", ["device", "deviceSeq"], { unique: true });
      }
      if (event.oldVersion < 3) {
        // A null `headword` is not a valid key, so a phrase or an unlisted
        // word stays out of this index.
        request.transaction!.objectStore(STORE_NAME).createIndex("headword", "headword");
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      // A connection the browser closes on its own (eviction, another tab's
      // version change) stops being usable synchronously too.
      database.onclose = () => {
        openDatabaseHandle = null;
        databasePromise = null;
      };
      // A newer tab upgrading the schema waits on this connection: close it
      // and let the next write reopen.
      database.onversionchange = () => {
        database.close();
        openDatabaseHandle = null;
        databasePromise = null;
      };
      openDatabaseHandle = database;
      resolve(database);
    };
    request.onerror = () => reject(request.error);
  });
  // Forget a connection that dies (deleted database, version change
  // elsewhere) so the next write reopens instead of retrying a dead handle.
  databasePromise.catch(() => {
    databasePromise = null;
    openDatabaseHandle = null;
  });
  return databasePromise;
}

// Starts the connection the moment this module loads, well before any query
// settles, so `openDatabaseHandle` is already warm by the time a tab dies.
if (typeof indexedDB !== "undefined") void openDatabase();
// Same moment: claim whatever the document this one replaced could not
// deliver, before anything in this document has a chance to relay a row
// of its own and overwrite the key first.
recoverRelayedRow();

// Parses whatever is under `PENDING_RELAY_KEY` as a list. A single stray
// object from a build before this list existed is read as empty rather than
// thrown on: a mixed-version rollout is not a crash, just a row this
// document cannot recover — the next commit still relays fine.
function readRelayedRows(): LookupRecord[] {
  const raw = localStorage.getItem(PENDING_RELAY_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) return parsed as LookupRecord[];
  // The relay held one bare object until 2026-09-10. A reader whose row was
  // in flight across that deploy has that shape on disk and one document
  // left to recover it in: read it as a list of one rather than dropping it.
  return parsed !== null && typeof parsed === "object" ? [parsed as LookupRecord] : [];
}

// Appends `row` to whatever list was already relayed: a flush that commits
// two rows in one synchronous pass must not have the second erase the
// first, only the write itself can fail. `setItem` never partially writes —
// it replaces the key whole or, on a full or disabled store, not at all —
// so a row already resting there survives a sibling's own failed relay.
function relayPendingRow(row: LookupRecord): void {
  if (typeof localStorage === "undefined") return;
  try {
    const relayed = readRelayedRows();
    relayed.push(row);
    localStorage.setItem(PENDING_RELAY_KEY, JSON.stringify(relayed));
  } catch {
    // The IndexedDB attempt still stands on its own; see above.
  }
}

// Drops `row` alone from the relayed list, once its own fate — committed or
// failed — is known. Leaves every other row named there untouched: two rows
// can be in flight at once, each with its own `writeRow`/`writeRowSync`
// callback racing the next navigation, and one landing must never take a
// companion's spot in the list down with it.
function clearRelayedRow(row: LookupRecord): void {
  if (typeof localStorage === "undefined") return;
  try {
    const relayed = readRelayedRows();
    const remaining = relayed.filter((r) => !(r.at === row.at && r.normalised === row.normalised));
    if (remaining.length === relayed.length) return;
    if (remaining.length === 0) {
      localStorage.removeItem(PENDING_RELAY_KEY);
    } else {
      localStorage.setItem(PENDING_RELAY_KEY, JSON.stringify(remaining));
    }
  } catch {
    // A list this document cannot parse cannot be trimmed row by row
    // either: drop the whole key rather than keep guessing at it.
    localStorage.removeItem(PENDING_RELAY_KEY);
  }
}

// Writes `row` unless one with the same `at` and `normalised` is already
// there. The check and the `add` share one transaction — never a read
// first and a separate write after — because a second `readwrite`
// transaction on `lookups` cannot open until this one finishes: nothing can
// land between the two here, where a second transaction could still race
// this one open. `at` names the settle that produced the row, not the
// moment it happens to be written, so a real repeat search keeps its own
// row: two settles landing the same millisecond is the recovery race
// below, never a reader.
async function writeRow(row: LookupRecord): Promise<void> {
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const existing = store.index(AT_INDEX).getAll(row.at);
      existing.onsuccess = () => {
        const alreadyLanded = (existing.result as LookupRecord[]).some(
          (candidate) => candidate.normalised === row.normalised,
        );
        if (!alreadyLanded) store.add(row);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    // A caller learns nothing about whether a write succeeded, by design.
    databasePromise = null;
  } finally {
    clearRelayedRow(row);
  }
}

// Reads back every row the previous document relayed and never got to clear
// — the sign its own IndexedDB write did not survive it, or the sign it did
// and only the callback that would have cleared this same entry did not
// (`writeRow`'s own guard, above, is what a killed tab's surviving write
// needs) — and writes each one here instead, oldest first. `writeRow`
// clears its own row out of the list once it lands, the same as it would
// for a row committed the ordinary way, so one row's write never waits on
// another's.
function recoverRelayedRow(): void {
  if (typeof localStorage === "undefined") return;
  const raw = localStorage.getItem(PENDING_RELAY_KEY);
  if (!raw) return;
  try {
    for (const row of readRelayedRows()) {
      void writeRow(row).then(notifyFlushed);
    }
  } catch {
    localStorage.removeItem(PENDING_RELAY_KEY);
  }
}

// Same write, issued with no `await` at all: the transaction opens in the
// caller's own task, which is the only way it stands a chance of surviving
// a page that dies before the event loop grants it another one. Returns
// whether it managed to start — never whether it committed.
function writeRowSync(row: LookupRecord): boolean {
  if (!openDatabaseHandle) return false;
  try {
    const transaction = openDatabaseHandle.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).add(row);
    transaction.oncomplete = () => {
      clearRelayedRow(row);
      notifyFlushed();
    };
    transaction.onerror = () => {
      clearRelayedRow(row);
      databasePromise = null;
      openDatabaseHandle = null;
    };
    transaction.onabort = () => {
      clearRelayedRow(row);
      databasePromise = null;
      openDatabaseHandle = null;
    };
    return true;
  } catch {
    return false;
  }
}

// A screen that reads `lookups` (`history-list.tsx`) listens for this to
// reread once a row it may already have missed actually lands — the write
// below is still async even after a caller forces it, so the event fires
// only once the transaction that carries it has committed.
export const LOG_FLUSHED_EVENT = "voyager:log-flushed";

function notifyFlushed(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LOG_FLUSHED_EVENT));
}

// RL-55: a word that matched nothing and a sentence that could not be
// translated leave no row. The guard lives here, at the one place every
// settled candidate — hit or miss — ends up, never at the call that reports
// it: `recordLookup` still has to run for a miss, so it can displace
// whatever prefix was pending and let the chain keep extending past it.
//
// Relays to `localStorage` before either IndexedDB path is even tried: a
// killed tab still lets its transaction commit (measured), but a reload, a
// URL navigation or a history traversal tears the document down before its
// transaction's own callback ever runs, and the add() beneath it is lost
// with it. The relay is this commit's only copy until that callback proves
// the write landed and clears it.
//
// Tries the same-task IndexedDB path first — it costs nothing when the
// connection is already warm, which is nearly always, and it is the only
// path a dying page can still complete. Falls back to the awaited path
// only while the connection is still opening, a gap that closes once,
// early, at load.
//
// The outcome check runs before the relay is even touched: a miss must
// never sit in `localStorage` waiting for a load that would resurrect it,
// the same as it must never reach IndexedDB.
function commit(row: LookupRecord): void {
  if (!isRecordedOutcome(row.outcome)) return;
  relayPendingRow(row);
  if (writeRowSync(row)) return;
  void writeRow(row).then(notifyFlushed);
}

function isStrictPrefix(previous: string, next: string): boolean {
  return next !== previous && next.startsWith(previous);
}

// The one pending row this module ever holds, and the timer that governs it.
let pending: LookupRecord | null = null;
let latestCandidate: LookupRecord | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

// Folds the most recent, not-yet-settled call into `pending`: merges it into
// a same-word chain, or commits the displaced row and starts a new chain.
// The chain closes only where `flushPendingLookup` is called from — the box
// emptying, this screen unmounting, the tab hiding or the page unloading —
// never on a clock: a reader who pauses mid-word for longer than that keeps
// one row, not one per pause.
function settleCandidate(): void {
  const candidate = latestCandidate;
  latestCandidate = null;
  if (!candidate) return;
  if (pending && isStrictPrefix(pending.normalised, candidate.normalised)) {
    pending = candidate;
    return;
  }
  if (pending) commit(pending);
  pending = candidate;
}

function onSettleTimer(): void {
  settleTimer = null;
  settleCandidate();
}

/**
 * Buffers one keystroke's answer, hit or miss alike — a miss still has to
 * pass through here to displace whatever prefix was pending. Returns
 * `void`, never a promise, so no caller can put a write on the path that
 * produces an answer (RNL-06). `commit`'s own guard, above, decides whether
 * and when this ever reaches IndexedDB.
 */
export function recordLookup(row: Omit<LookupRecord, "id" | "schema">): void {
  latestCandidate = pendingRowFrom(row);
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(onSettleTimer, SETTLE_MS);
}

/**
 * Forces the pending row to IndexedDB now. Call this when the box empties:
 * the guard has no other way to learn a query was abandoned mid-word. Also
 * fires on tab hide and page hide, where `commit` above starts the write in
 * the same task instead of behind a promise and relays a copy to
 * `localStorage` first — a killed tab lets the IndexedDB write finish on
 * its own, but a reload, a URL navigation or a history traversal can tear
 * the document down before it does, and the next document's own load is
 * what actually lands the row then.
 */
export function flushPendingLookup(): void {
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
  settleCandidate();
  if (pending) {
    commit(pending);
    pending = null;
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushPendingLookup();
  });
}
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPendingLookup);
}

export async function countRecords(): Promise<number> {
  const database = await openDatabase();
  return new Promise<number>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readAll(): Promise<LookupRecord[]> {
  const database = await openDatabase();
  return new Promise<LookupRecord[]>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as LookupRecord[]);
    request.onerror = () => reject(request.error);
  });
}

/** The open connection, for the merge module's transactions on `lookups`. */
export function openLogDatabase(): Promise<IDBDatabase> {
  return openDatabase();
}

// `history-list.tsx` listens for this the same way it listens for
// `LOG_FLUSHED_EVENT`: a reread, not a diff. Kept separate from that event
// rather than reused — a row landing and the whole store emptying are not
// the same fact, and a listener added later for one should not have to
// filter out the other.
export const LOG_CLEARED_EVENT = "voyager:log-cleared";

/**
 * Empties `lookups` on this device only. Never touches `sync`: `pushedThroughLocalId`
 * and `pulledThroughCursor` stay where they were, which is what keeps a wiped
 * row from coming back on the next `syncNow()` — IndexedDB's own `clear()`
 * does not rewind the store's key generator, so a search recorded after this
 * still mints an `id` past every cursor already written, and a stale
 * `pulledThroughCursor` still names everything the account already sent down
 * as already seen. Measured driving `syncNow()` in `e2e/registro.spec.ts`.
 */
export async function clearLocalLookups(): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LOG_CLEARED_EVENT));
}

function defaultSyncState(): SyncState {
  return {
    deviceId: crypto.randomUUID(),
    pushedThroughLocalId: null,
    pulledThroughCursor: null,
    lastSyncedAt: null,
    enabled: false,
    readerId: null,
    retired: false,
  };
}

// One `readwrite` transaction: read, merge and write the `sync` row where
// IndexedDB serialises it against every other tab's transaction. Nothing is
// cached across calls — a copy held in a realm goes stale the moment another
// tab signs out or switches reader. A missing row is minted here too, so two
// tabs opened before the row exists cannot each mint a `deviceId`.
function updateSyncRow(
  database: IDBDatabase,
  patch: Partial<SyncState> | ((current: SyncState) => SyncState) | null,
): Promise<SyncState> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(SYNC_STORE_NAME, "readwrite");
    const store = transaction.objectStore(SYNC_STORE_NAME);
    let result: SyncState | null = null;
    const request = store.get(SYNC_KEY);
    request.onsuccess = () => {
      const existing = request.result as SyncRow | undefined;
      const current = existing ? normaliseSyncState(existing) : defaultSyncState();
      result = !patch ? current : typeof patch === "function" ? patch(current) : { ...current, ...patch };
      if (patch || !existing) store.put({ ...result, key: SYNC_KEY } satisfies SyncRow);
      else resolve(result);
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve(result as SyncState);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** The device's sync row, minting `deviceId` the first time it is read. */
export async function readSyncState(): Promise<SyncState> {
  try {
    return await updateSyncRow(await openDatabase(), null);
  } catch {
    return defaultSyncState();
  }
}

/** Merges `next` into the persisted state. A failed read writes nothing. */
export async function writeSyncState(next: Partial<SyncState>): Promise<void> {
  try {
    await updateSyncRow(await openDatabase(), next);
  } catch {
    databasePromise = null;
  }
}

// Decides from the row as the transaction reads it, not from an earlier read.
async function transformSyncState(change: (current: SyncState) => SyncState): Promise<SyncState> {
  try {
    return await updateSyncRow(await openDatabase(), change);
  } catch {
    databasePromise = null;
    return defaultSyncState();
  }
}

async function highestLocalId(): Promise<number | null> {
  const database = await openDatabase();
  return new Promise<number | null>((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .openCursor(null, "prev");
    request.onsuccess = () => resolve(request.result ? (request.result.key as number) : null);
    request.onerror = () => reject(request.error);
  });
}

/** How many of this device's own searches the copy has yet to upload. */
export async function countPendingUpload(): Promise<number> {
  const [rows, state] = await Promise.all([readAll(), readSyncState()]);
  return countPending(rows, state.pushedThroughLocalId);
}

/** Starts the copy for this reader: keeps the cursors only for the same reader on a live device; another reader leaves stored rows behind. */
export async function startCopyFor(readerId: string): Promise<SyncState> {
  const highest = await highestLocalId();
  return transformSyncState((current) => syncStateForReader(current, readerId, () => crypto.randomUUID(), highest));
}

/** Turns the copy off for a sign-out; a retired device also forgets its identity. */
export async function signOutSync(): Promise<void> {
  await transformSyncState((current) => signOutSyncState(current, () => crypto.randomUUID()));
}

/** The server retired this device: the copy stops until a new sign-in mints another. */
export async function markRetired(): Promise<void> {
  await writeSyncState({ retired: true, enabled: false });
}
