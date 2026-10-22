// RL-66 (device half) and RL-70: deleting a /registro row removes the group's
// searches from this device and queues their identities for the account;
// marks other devices made remove the rows they name here. Written from the
// contract: the group is the row's `headword ?? normalised` (summary.ts), the
// identity of a row is (device, deviceSeq) or, for one this device recorded,
// (own device, id).
//
// Node has no IndexedDB, so `./record`'s `openLogDatabase` is a stand-in that
// implements the calls a store/index/cursor user can make, with rollback on
// abort. Only observable behaviour is asserted: rows left in `lookups`, what
// `readTombstoneQueue` returns, the sync row, the events, the transactions.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

const OWN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";

type Row = Record<string, unknown>;
type Key = unknown;

// ---- a small IndexedDB ----

function compare(a: Key, b: Key): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compare(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

type Range = { lower?: Key; upper?: Key; lowerOpen: boolean; upperOpen: boolean };
const isRange = (query: unknown): query is Range =>
  typeof query === "object" && query !== null && !Array.isArray(query) && "lowerOpen" in query;

function inRange(key: Key, query: unknown): boolean {
  if (query === undefined || query === null) return true;
  if (!isRange(query)) return compare(key, query) === 0;
  if (query.lower !== undefined) {
    const c = compare(key, query.lower);
    if (c < 0 || (c === 0 && query.lowerOpen)) return false;
  }
  if (query.upper !== undefined) {
    const c = compare(key, query.upper);
    if (c > 0 || (c === 0 && query.upperOpen)) return false;
  }
  return true;
}

(globalThis as unknown as { IDBKeyRange: unknown }).IDBKeyRange = {
  only: (v: Key): Range => ({ lower: v, upper: v, lowerOpen: false, upperOpen: false }),
  lowerBound: (v: Key, open = false): Range => ({ lower: v, lowerOpen: open, upperOpen: false }),
  upperBound: (v: Key, open = false): Range => ({ upper: v, lowerOpen: false, upperOpen: open }),
  bound: (l: Key, u: Key, lo = false, uo = false): Range => ({ lower: l, upper: u, lowerOpen: lo, upperOpen: uo }),
};

type StoreData = {
  keyPath: string;
  auto: boolean;
  seq: number;
  rows: Map<Key, Row>;
  indexes: Record<string, string | string[]>;
};

function indexKey(row: Row, path: string | string[]): Key | undefined {
  if (Array.isArray(path)) {
    const parts = path.map((p) => row[p]);
    return parts.some((v) => v === undefined || v === null) ? undefined : parts;
  }
  const v = row[path];
  return v === undefined || v === null ? undefined : v;
}

let stores: Map<string, StoreData>;
let transactions: { scope: string[]; mode: string }[];
let refuseCommit: boolean;

function freshStores(): Map<string, StoreData> {
  return new Map<string, StoreData>([
    ["lookups", { keyPath: "id", auto: true, seq: 0, rows: new Map(), indexes: { at: "at", normalised: "normalised", headword: "headword", foreign: ["device", "deviceSeq"] } }],
    ["sync", { keyPath: "key", auto: false, seq: 0, rows: new Map(), indexes: {} }],
  ]);
}

type Req<T> = { result: T; error: Error | null; onsuccess: (() => void) | null; onerror: ((e: unknown) => void) | null };

function makeTransaction(scope: string[], mode: string) {
  transactions.push({ scope, mode });
  const snapshot = new Map([...stores].map(([n, s]) => [n, { seq: s.seq, rows: new Map([...s.rows].map(([k, v]) => [k, structuredClone(v)])) }]));
  let pending = 0;
  let settled = false;
  const tx = {
    oncomplete: null as (() => void) | null,
    onabort: null as (() => void) | null,
    onerror: null as (() => void) | null,
    error: null as Error | null,
    abort() {
      fail(new Error("aborted"));
    },
    objectStore(name: string) {
      assert.ok(scope.includes(name), `store ${name} outside the transaction scope ${scope}`);
      return storeHandle(stores.get(name)!, mode);
    },
  };
  function fail(error: Error) {
    if (settled) return;
    settled = true;
    for (const [n, s] of stores) {
      const snap = snapshot.get(n)!;
      s.seq = snap.seq;
      s.rows = snap.rows;
    }
    tx.error = error;
    queueMicrotask(() => {
      tx.onerror?.();
      tx.onabort?.();
    });
  }
  function end() {
    pending -= 1;
    if (pending > 0) return;
    // A real transaction commits once the task that fired the last request
    // callback, microtasks included, has drained: a `await` chain still gets to
    // issue its next request.
    setImmediate(() => {
      if (pending > 0 || settled) return;
      if (refuseCommit) return fail(new Error("refused"));
      settled = true;
      tx.oncomplete?.();
    });
  }
  function request<T>(run: () => T): Req<T> {
    assert.ok(!settled, "request on a finished transaction");
    const req: Req<T> = { result: undefined as T, error: null, onsuccess: null, onerror: null };
    pending += 1;
    queueMicrotask(() => {
      if (settled) return;
      try {
        req.result = run();
      } catch (e) {
        req.error = e as Error;
        req.onerror?.({ preventDefault() {} });
        fail(e as Error);
        return;
      }
      req.onsuccess?.();
      end();
    });
    return req;
  }

  function ordered(store: StoreData, index: string | null, query: unknown): { key: Key; primary: Key; row: Row }[] {
    const out: { key: Key; primary: Key; row: Row }[] = [];
    for (const [primary, row] of store.rows) {
      const key = index ? indexKey(row, store.indexes[index]) : primary;
      if (key === undefined || !inRange(key, query)) continue;
      out.push({ key, primary, row });
    }
    return out.sort((a, b) => compare(a.key, b.key) || compare(a.primary, b.primary));
  }

  function reader(store: StoreData, index: string | null) {
    const entries = (query?: unknown) => ordered(store, index, query);
    return {
      get: (q: unknown) => request(() => structuredClone(entries(q)[0]?.row)),
      getKey: (q: unknown) => request(() => entries(q)[0]?.primary),
      getAll: (q?: unknown, count?: number) => request(() => entries(q).slice(0, count).map((e) => structuredClone(e.row))),
      getAllKeys: (q?: unknown, count?: number) => request(() => entries(q).slice(0, count).map((e) => e.primary)),
      count: (q?: unknown) => request(() => entries(q).length),
      openCursor: (q?: unknown, direction: string = "next") => openCursor(entries(q), store, direction, true),
      openKeyCursor: (q?: unknown, direction: string = "next") => openCursor(entries(q), store, direction, false),
    };
  }

  function openCursor(list: { key: Key; primary: Key; row: Row }[], store: StoreData, direction: string, withValue: boolean) {
    const items = direction.startsWith("prev") ? [...list].reverse() : list;
    let at = 0;
    const req: Req<unknown> = { result: null, error: null, onsuccess: null, onerror: null };
    const present = () => {
      const item = items[at];
      req.result = item
        ? {
            key: item.key,
            primaryKey: item.primary,
            ...(withValue ? { value: structuredClone(item.row) } : {}),
            continue() {
              at += 1;
              pending += 1;
              queueMicrotask(() => {
                present();
                req.onsuccess?.();
                end();
              });
            },
            delete: () => request(() => void store.rows.delete(item.primary)),
            update: (v: Row) => request(() => void store.rows.set(item.primary, structuredClone(v))),
          }
        : null;
    };
    pending += 1;
    queueMicrotask(() => {
      present();
      req.onsuccess?.();
      end();
    });
    return req;
  }

  function storeHandle(store: StoreData, txMode: string) {
    const write = (row: Row, overwrite: boolean) =>
      request(() => {
        assert.equal(txMode, "readwrite", "write in a readonly transaction");
        const value = structuredClone(row);
        if (value[store.keyPath] === undefined) {
          assert.ok(store.auto, "a key-less row in a store with no key generator");
          store.seq += 1;
          value[store.keyPath] = store.seq;
        } else if (typeof value[store.keyPath] === "number") {
          store.seq = Math.max(store.seq, value[store.keyPath] as number);
        }
        const pk = value[store.keyPath];
        if (!overwrite && store.rows.has(pk)) throw Object.assign(new Error("exists"), { name: "ConstraintError" });
        if (store.indexes.foreign) {
          const fk = indexKey(value, store.indexes.foreign);
          if (fk !== undefined) {
            for (const [other, existing] of store.rows) {
              if (other !== pk && compare(indexKey(existing, store.indexes.foreign), fk) === 0) {
                throw Object.assign(new Error("unique"), { name: "ConstraintError" });
              }
            }
          }
        }
        store.rows.set(pk, value);
        return pk;
      });
    return {
      ...reader(store, null),
      add: (row: Row) => write(row, false),
      put: (row: Row) => write(row, true),
      delete: (q: unknown) =>
        request(() => {
          assert.equal(txMode, "readwrite", "delete in a readonly transaction");
          if (!isRange(q) && q !== undefined && q !== null) return void store.rows.delete(q);
          for (const e of ordered(store, null, q)) store.rows.delete(e.primary);
        }),
      clear: () => request(() => void store.rows.clear()),
      index: (name: string) => {
        assert.ok(store.indexes[name], `no index ${name}`);
        return reader(store, name);
      },
    };
  }
  return tx;
}

const database = {
  transaction(scope: string | string[], mode = "readonly") {
    return makeTransaction(Array.isArray(scope) ? scope : [scope], mode);
  },
  objectStoreNames: { contains: (n: string) => stores.has(n) },
};

mock.module("./record", {
  namedExports: { openLogDatabase: async () => database, DATABASE_VERSION: 3 },
});

type Delete = typeof import("./delete");
let loaded: Delete | null = null;
async function load(): Promise<Delete> {
  return (loaded ??= await import("./delete"));
}

let events: string[] = [];

function lookup(over: Row): Row {
  return {
    schema: 3, at: 1_700_000_000_000, text: "x", normalised: "x", kind: "word", outcome: "exact", headword: null,
    rule: null, senses: 1, translation: null, dictionaryReady: true, origin: "device", ...over,
  };
}

function put(storeName: string, row: Row) {
  const store = stores.get(storeName)!;
  const value = structuredClone(row);
  if (value[store.keyPath] === undefined) {
    store.seq += 1;
    value[store.keyPath] = store.seq;
  } else if (typeof value[store.keyPath] === "number") store.seq = Math.max(store.seq, value[store.keyPath] as number);
  store.rows.set(value[store.keyPath], value);
}

const syncState = (over: Row = {}): Row => ({
  key: "state", deviceId: OWN, pushedThroughLocalId: null, pulledThroughCursor: null, lastSyncedAt: null,
  enabled: true, readerId: "reader-1", retired: false, ...over,
});

const remaining = () => [...stores.get("lookups")!.rows.values()].map((r) => r.id as number).sort((a, b) => a - b);

beforeEach(() => {
  stores = freshStores();
  transactions = [];
  refuseCommit = false;
  events = [];
  Object.assign(globalThis, {
    window: { dispatchEvent: (event: Event) => (events.push(event.type), true) },
  });
});

const byLocalId = (a: { localId: number }, b: { localId: number }) => a.localId - b.localId;

// ---- planGroupDelete ----

test("planGroupDelete takes the row's own group by headword ?? normalised, never the lemma-history union", async () => {
  const { planGroupDelete } = await load();
  const rows = [
    lookup({ id: 1, normalised: "left", headword: "leave" }), // inflected form reaching leave: in
    lookup({ id: 2, normalised: "leave", headword: "leave" }), // in
    lookup({ id: 3, normalised: "left", headword: "left" }), // its own headword left: out
    lookup({ id: 4, normalised: "leave", headword: "leaf" }), // typed leave, but it reached leaf: out (the union would take it)
    lookup({ id: 5, normalised: "leave", headword: null }), // no headword, so its group is its normalised: in
  ] as never[];
  const plan = planGroupDelete(rows, "leave", OWN);
  assert.deepEqual([...plan.ids].sort((a, b) => a - b), [1, 2, 5]);
  assert.deepEqual([...plan.tombstones].sort(byLocalId), [
    { deviceId: OWN, localId: 1 },
    { deviceId: OWN, localId: 2 },
    { deviceId: OWN, localId: 5 },
  ]);
});

test("planGroupDelete names a row by the identity it carries: pulled (device, deviceSeq), own (own device, id)", async () => {
  const { planGroupDelete } = await load();
  const rows = [
    lookup({ id: 4, normalised: "cat", headword: "cat" }),
    lookup({ id: 5, normalised: "cat", headword: "cat", device: OTHER, deviceSeq: 9 }),
    lookup({ id: 6, normalised: "cat", headword: "cat", device: null, deviceSeq: null }),
    lookup({ id: 7, normalised: "cat", headword: "cat", device: THIRD, deviceSeq: 4 }),
  ] as never[];
  const plan = planGroupDelete(rows, "cat", OWN);
  assert.deepEqual([...plan.ids].sort((a, b) => a - b), [4, 5, 6, 7]);
  const named = [...plan.tombstones].sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.localId - b.localId);
  assert.deepEqual(named, [
    { deviceId: OWN, localId: 4 },
    { deviceId: OWN, localId: 6 },
    { deviceId: OTHER, localId: 9 },
    { deviceId: THIRD, localId: 4 },
  ]);
});

test("planGroupDelete over a key no row has names nothing", async () => {
  const { planGroupDelete } = await load();
  const plan = planGroupDelete([lookup({ id: 1, normalised: "cat", headword: "cat" })] as never[], "dog", OWN);
  assert.deepEqual(plan, { ids: [], tombstones: [] });
});

// ---- deleteStudyGroup ----

function seedGroupWorld(syncOver: Row | null = {}) {
  put("lookups", lookup({ normalised: "left", headword: "leave", text: "left" })); // 1
  put("lookups", lookup({ normalised: "leave", headword: "leave", text: "leave" })); // 2
  put("lookups", lookup({ normalised: "left", headword: "left", text: "left" })); // 3
  put("lookups", lookup({ normalised: "leave", headword: "leaf", text: "leave" })); // 4
  put("lookups", lookup({ normalised: "leave", headword: null, text: "leave" })); // 5
  put("lookups", lookup({ normalised: "leave", headword: "leave", device: OTHER, deviceSeq: 8 })); // 6
  if (syncOver) put("sync", syncState(syncOver));
}

test("deleteStudyGroup removes the group's rows, own and pulled, and leaves every other row", async () => {
  seedGroupWorld();
  const { deleteStudyGroup } = await load();
  const result = await deleteStudyGroup("leave");
  assert.deepEqual(result, { deleted: 4 });
  assert.deepEqual(remaining(), [3, 4]);
});

test("deleteStudyGroup queues the group's identities for this reader, to be read back whole", async () => {
  seedGroupWorld();
  const { deleteStudyGroup, readTombstoneQueue } = await load();
  await deleteStudyGroup("leave");
  const queue = await readTombstoneQueue("reader-1");
  const named = [...queue.pending].sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.localId - b.localId);
  assert.deepEqual(named, [
    { deviceId: OWN, localId: 1 },
    { deviceId: OWN, localId: 2 },
    { deviceId: OWN, localId: 5 },
    { deviceId: OTHER, localId: 8 },
  ]);
  assert.equal(queue.since, null);
});

test("a queue is never read back for another reader", async () => {
  seedGroupWorld();
  const { deleteStudyGroup, readTombstoneQueue } = await load();
  await deleteStudyGroup("leave");
  assert.deepEqual(await readTombstoneQueue("reader-2"), { pending: [], since: null });
  assert.equal((await readTombstoneQueue("reader-1")).pending.length, 4);
});

test("with no reader on the sync row the rows go and nothing is queued", async () => {
  seedGroupWorld({ readerId: null });
  const { deleteStudyGroup, readTombstoneQueue } = await load();
  assert.deepEqual(await deleteStudyGroup("leave"), { deleted: 4 });
  assert.deepEqual(remaining(), [3, 4]);
  assert.deepEqual((await readTombstoneQueue("reader-1")).pending, []);
  assert.equal(stores.get("sync")!.rows.has("tombstones"), false, "a queue was written for no reader");
});

test("with a reader on the sync row the queue lives under the sync key \"tombstones\"", async () => {
  seedGroupWorld();
  const { deleteStudyGroup } = await load();
  await deleteStudyGroup("leave");
  assert.equal(stores.get("sync")!.rows.has("tombstones"), true);
});

test("with no sync row at all the rows go and nothing is queued", async () => {
  seedGroupWorld(null);
  const { deleteStudyGroup, readTombstoneQueue } = await load();
  assert.deepEqual(await deleteStudyGroup("leave"), { deleted: 4 });
  assert.deepEqual((await readTombstoneQueue("reader-1")).pending, []);
  assert.equal(stores.get("sync")!.rows.has("tombstones"), false);
});

test("deleting touches neither the sync state nor the schema version", async () => {
  seedGroupWorld({ pushedThroughLocalId: 6, pulledThroughCursor: "c9", lastSyncedAt: 5 });
  const before = structuredClone(stores.get("sync")!.rows.get("state"));
  const { deleteStudyGroup } = await load();
  await deleteStudyGroup("leave");
  assert.deepEqual(stores.get("sync")!.rows.get("state"), before);
});

test("one readwrite transaction over lookups and sync does the whole delete", async () => {
  seedGroupWorld();
  const { deleteStudyGroup } = await load();
  await deleteStudyGroup("leave");
  assert.equal(transactions.length, 1, `transactions opened: ${JSON.stringify(transactions)}`);
  assert.equal(transactions[0].mode, "readwrite");
  assert.ok(transactions[0].scope.includes("lookups") && transactions[0].scope.includes("sync"));
});

test("a refused transaction throws and leaves the rows and the queue as they were", async () => {
  seedGroupWorld();
  const { deleteStudyGroup, readTombstoneQueue } = await load();
  refuseCommit = true;
  await assert.rejects(deleteStudyGroup("leave"));
  refuseCommit = false;
  assert.deepEqual(remaining(), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual((await readTombstoneQueue("reader-1")).pending, []);
  assert.deepEqual(events, [], "an event announced a delete that did not happen");
});

test("a delete announces itself with LOG_DELETED_EVENT, once", async () => {
  seedGroupWorld();
  const { deleteStudyGroup, LOG_DELETED_EVENT } = await load();
  assert.equal(LOG_DELETED_EVENT, "voyager:log-deleted");
  await deleteStudyGroup("leave");
  assert.deepEqual(events, ["voyager:log-deleted"]);
});

test("a key no row has deletes nothing and queues nothing", async () => {
  seedGroupWorld();
  const { deleteStudyGroup, readTombstoneQueue } = await load();
  assert.deepEqual(await deleteStudyGroup("zebra"), { deleted: 0 });
  assert.deepEqual(remaining(), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual((await readTombstoneQueue("reader-1")).pending, []);
});

// ---- settleTombstones ----

test("settleTombstones drops what was sent, keeps the rest, and stores the mark cursor", async () => {
  seedGroupWorld();
  const { deleteStudyGroup, readTombstoneQueue, settleTombstones } = await load();
  await deleteStudyGroup("leave");
  await settleTombstones("reader-1", [{ deviceId: OWN, localId: 1 }, { deviceId: OTHER, localId: 8 }], "t-cursor-1");
  const queue = await readTombstoneQueue("reader-1");
  const named = [...queue.pending].sort(byLocalId);
  assert.deepEqual(named, [
    { deviceId: OWN, localId: 2 },
    { deviceId: OWN, localId: 5 },
  ]);
  assert.equal(queue.since, "t-cursor-1");
});

test("a mark queued while a round was in flight survives that round's settle", async () => {
  seedGroupWorld();
  const { deleteStudyGroup, readTombstoneQueue, settleTombstones } = await load();
  await deleteStudyGroup("leave");
  const sent = (await readTombstoneQueue("reader-1")).pending;
  put("lookups", lookup({ normalised: "cat", headword: "cat", text: "cat" })); // id 7
  await deleteStudyGroup("cat");
  await settleTombstones("reader-1", sent, "c1");
  assert.deepEqual((await readTombstoneQueue("reader-1")).pending, [{ deviceId: OWN, localId: 7 }]);
});

test("the mark cursor is kept per reader: another reader starts with none", async () => {
  seedGroupWorld();
  const { settleTombstones, readTombstoneQueue } = await load();
  await settleTombstones("reader-1", [], "c1");
  assert.equal((await readTombstoneQueue("reader-1")).since, "c1");
  assert.equal((await readTombstoneQueue("reader-2")).since, null);
});

// ---- applyTombstones ----

function seedApplyWorld() {
  put("lookups", lookup({ normalised: "alpha", headword: "alpha" })); // 1 own
  put("lookups", lookup({ normalised: "beta", headword: "beta" })); // 2 own
  put("lookups", lookup({ normalised: "gamma", headword: "gamma", device: OTHER, deviceSeq: 5 })); // 3 foreign
  put("lookups", lookup({ normalised: "delta", headword: "delta", device: OTHER, deviceSeq: 6 })); // 4 foreign
  put("lookups", lookup({ normalised: "eps", headword: "eps", device: THIRD, deviceSeq: 1 })); // 5 foreign
}

test("applyTombstones deletes an own row by id and a pulled row by (device, deviceSeq), and counts them", async () => {
  seedApplyWorld();
  const { applyTombstones } = await load();
  const removed = await applyTombstones([{ deviceId: OWN, localId: 1 }, { deviceId: OTHER, localId: 5 }], OWN);
  assert.equal(removed, 2);
  assert.deepEqual(remaining(), [2, 4, 5]);
});

test("an own mark never reaches a pulled row that happens to share the id", async () => {
  seedApplyWorld();
  const { applyTombstones } = await load();
  const removed = await applyTombstones([{ deviceId: OWN, localId: 3 }], OWN); // id 3 is a pulled row
  assert.equal(removed, 0);
  assert.deepEqual(remaining(), [1, 2, 3, 4, 5]);
});

test("a foreign mark never reaches an own row that happens to share the number", async () => {
  seedApplyWorld();
  const { applyTombstones } = await load();
  const removed = await applyTombstones([{ deviceId: THIRD, localId: 1 }, { deviceId: OTHER, localId: 1 }], OWN);
  assert.equal(removed, 1); // only (THIRD, 1)
  assert.deepEqual(remaining(), [1, 2, 3, 4]);
});

test("marks naming rows this device does not hold are ignored, and a repeat removes nothing more", async () => {
  seedApplyWorld();
  const { applyTombstones } = await load();
  const marks = [{ deviceId: OWN, localId: 99 }, { deviceId: OTHER, localId: 77 }, { deviceId: OTHER, localId: 6 }];
  assert.equal(await applyTombstones(marks, OWN), 1);
  assert.equal(await applyTombstones(marks, OWN), 0);
  assert.deepEqual(remaining(), [1, 2, 3, 5]);
});

test("no marks, no change", async () => {
  seedApplyWorld();
  const { applyTombstones } = await load();
  assert.equal(await applyTombstones([], OWN), 0);
  assert.deepEqual(remaining(), [1, 2, 3, 4, 5]);
});

test("applying marks does not queue them back up", async () => {
  seedApplyWorld();
  put("sync", syncState());
  const { applyTombstones, readTombstoneQueue } = await load();
  await applyTombstones([{ deviceId: OWN, localId: 1 }, { deviceId: OTHER, localId: 5 }], OWN);
  assert.deepEqual((await readTombstoneQueue("reader-1")).pending, []);
});

// ---- the queue merge (M35) ----

const queueRow = (pending: { deviceId: string; localId: number }[]): Row => ({
  key: "tombstones", readerId: "reader-1", pending, since: null,
});

test("a mark already queued is not queued twice, and the fresh ones follow the queue in row order", async () => {
  put("lookups", lookup({ normalised: "cat", headword: "cat" })); // 1
  put("lookups", lookup({ normalised: "cat", headword: "cat" })); // 2
  put("lookups", lookup({ normalised: "cat", headword: "cat", device: OTHER, deviceSeq: 7 })); // 3
  put("sync", syncState());
  put("sync", queueRow([{ deviceId: OTHER, localId: 7 }, { deviceId: THIRD, localId: 40 }, { deviceId: OWN, localId: 2 }]));
  const { deleteStudyGroup, readTombstoneQueue } = await load();
  await deleteStudyGroup("cat");
  assert.deepEqual((await readTombstoneQueue("reader-1")).pending, [
    { deviceId: OTHER, localId: 7 },
    { deviceId: THIRD, localId: 40 },
    { deviceId: OWN, localId: 2 },
    { deviceId: OWN, localId: 1 },
  ]);
});

test("a second delete of the same group queues nothing new", async () => {
  put("lookups", lookup({ normalised: "cat", headword: "cat" }));
  put("sync", syncState());
  const { deleteStudyGroup, readTombstoneQueue } = await load();
  await deleteStudyGroup("cat");
  put("lookups", lookup({ id: 1, normalised: "cat", headword: "cat" })); // the same identity comes back
  await deleteStudyGroup("cat");
  assert.deepEqual((await readTombstoneQueue("reader-1")).pending, [{ deviceId: OWN, localId: 1 }]);
});

test("a queued mark of another device with the same localId does not hide a fresh mark", async () => {
  put("lookups", lookup({ normalised: "cat", headword: "cat" })); // own, id 1
  put("sync", syncState());
  put("sync", queueRow([{ deviceId: OTHER, localId: 1 }]));
  const { deleteStudyGroup, readTombstoneQueue } = await load();
  await deleteStudyGroup("cat");
  assert.deepEqual((await readTombstoneQueue("reader-1")).pending, [
    { deviceId: OTHER, localId: 1 },
    { deviceId: OWN, localId: 1 },
  ]);
});

test("the same localId under two devices is two marks, and a device is not confused with another by its prefix", async () => {
  put("lookups", lookup({ normalised: "cat", headword: "cat", device: OTHER, deviceSeq: 12 }));
  put("lookups", lookup({ normalised: "cat", headword: "cat", device: THIRD, deviceSeq: 12 }));
  put("sync", syncState());
  put("sync", queueRow([{ deviceId: OTHER, localId: 12 }]));
  const { deleteStudyGroup, readTombstoneQueue } = await load();
  await deleteStudyGroup("cat");
  assert.deepEqual((await readTombstoneQueue("reader-1")).pending, [
    { deviceId: OTHER, localId: 12 },
    { deviceId: THIRD, localId: 12 },
  ]);
});

// Work done, not time: each element a search method visits on a long array is
// counted. A merge that scans the queue once per mark visits ~N^2 of them.
function countSearchVisits<T>(run: () => Promise<T>): Promise<{ visits: number; value: T }> {
  const proto = Array.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originals: Record<string, (...args: unknown[]) => unknown> = {};
  let visits = 0;
  for (const name of ["some", "find", "findIndex", "findLast", "findLastIndex", "every"]) {
    originals[name] = proto[name];
    proto[name] = function (this: unknown[], ...args: unknown[]) {
      if (this.length <= 10) return originals[name].call(this, ...args);
      const [callback, ...rest] = args as [(...a: unknown[]) => unknown, ...unknown[]];
      return originals[name].call(this, (...a: unknown[]) => (visits++, callback(...a)), ...rest);
    };
  }
  for (const name of ["includes", "indexOf", "lastIndexOf"]) {
    originals[name] = proto[name];
    proto[name] = function (this: unknown[], ...args: unknown[]) {
      if (this.length > 10) visits += this.length;
      return originals[name].call(this, ...args);
    };
  }
  const restore = () => {
    for (const name of Object.keys(originals)) proto[name] = originals[name];
  };
  return run().then(
    (value) => (restore(), { visits, value }),
    (error) => (restore(), Promise.reject(error)),
  );
}

async function mergeOf(N: number) {
  stores = freshStores();
  for (let i = 0; i < N; i++) put("lookups", lookup({ normalised: "big", headword: "big" })); // own ids 1..N
  put("sync", syncState());
  // Half the queue repeats the group's first marks; the rest belong to another device.
  const queued = [
    ...Array.from({ length: N / 2 }, (_, i) => ({ deviceId: OWN, localId: i + 1 })),
    ...Array.from({ length: N / 2 }, (_, i) => ({ deviceId: OTHER, localId: i + 1 })),
  ];
  put("sync", queueRow(queued));
  const { deleteStudyGroup, readTombstoneQueue } = await load();
  const { visits, value } = await countSearchVisits(() => deleteStudyGroup("big"));
  assert.deepEqual(value, { deleted: N });
  const expected = [...queued, ...Array.from({ length: N / 2 }, (_, i) => ({ deviceId: OWN, localId: N / 2 + i + 1 }))];
  assert.deepEqual((await readTombstoneQueue("reader-1")).pending, expected);
  return visits;
}

test("the merge's work grows linearly with the marks: 400 marks cost at most 4x of 100, plus a constant", async () => {
  const small = await mergeOf(100);
  const mid = await mergeOf(200);
  const large = await mergeOf(400);
  assert.ok(large <= 4 * small + 400, `visits for 100/200/400 marks: ${small}/${mid}/${large}: not linear`);
  assert.ok(mid <= 2 * small + 200, `visits for 100/200 marks: ${small}/${mid}: not linear`);
});

// ---- the queue never names a mark twice, and never merges two marks into one ----

test("two rows that name one mark queue it once", async () => {
  put("lookups", lookup({ normalised: "dup", headword: "dup" })); // id 1, own: (OWN, 1)
  put("lookups", lookup({ normalised: "dup", headword: "dup", device: OWN, deviceSeq: 1 })); // also (OWN, 1)
  put("sync", syncState());
  const { deleteStudyGroup, readTombstoneQueue } = await load();
  assert.deepEqual(await deleteStudyGroup("dup"), { deleted: 2 });
  assert.deepEqual((await readTombstoneQueue("reader-1")).pending, [{ deviceId: OWN, localId: 1 }]);
});

test("a mark already queued is not queued again", async () => {
  put("lookups", lookup({ normalised: "dup", headword: "dup" })); // (OWN, 1)
  put("sync", syncState());
  put("sync", { key: "tombstones", readerId: "reader-1", pending: [{ deviceId: OWN, localId: 1 }], since: null });
  const { deleteStudyGroup, readTombstoneQueue } = await load();
  await deleteStudyGroup("dup");
  assert.deepEqual((await readTombstoneQueue("reader-1")).pending, [{ deviceId: OWN, localId: 1 }]);
});

test("two different marks whose parts concatenate alike are both queued", async () => {
  put("lookups", lookup({ normalised: "col", headword: "col", device: "d12", deviceSeq: 3 }));
  put("sync", syncState());
  put("sync", { key: "tombstones", readerId: "reader-1", pending: [{ deviceId: "d1", localId: 23 }], since: null });
  const { deleteStudyGroup, readTombstoneQueue } = await load();
  await deleteStudyGroup("col");
  const named = (await readTombstoneQueue("reader-1")).pending;
  assert.deepEqual(
    [...named].sort((a, b) => a.deviceId.localeCompare(b.deviceId)),
    [{ deviceId: "d1", localId: 23 }, { deviceId: "d12", localId: 3 }],
  );
});

// ---- settleTombstones: the settle is linear (o5-m8) ----

type Mark = { deviceId: string; localId: number };

// The old function, kept as the reference: what a settle must still store.
const referenceSettle = (pending: Mark[], sent: Mark[]) =>
  pending.filter((q) => !sent.some((m) => m.deviceId === q.deviceId && m.localId === q.localId));

test("settleTombstones keeps exactly what the reference filter keeps, over 200 random queues", async () => {
  const { settleTombstones, readTombstoneQueue } = await load();
  const devices = [OWN, OTHER, THIRD];
  let seed = 20261022;
  const next = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (let trial = 0; trial < 200; trial++) {
    stores = freshStores();
    const mark = (): Mark => ({ deviceId: devices[next(3)], localId: next(12) });
    const pending = Array.from({ length: next(15) }, mark);
    const sent = Array.from({ length: next(15) }, mark);
    put("sync", queueRow(pending));
    await settleTombstones("reader-1", sent, `c${trial}`);
    const queue = await readTombstoneQueue("reader-1");
    assert.deepEqual(queue.pending, referenceSettle(pending, sent), `trial ${trial}`);
    assert.equal(queue.since, `c${trial}`);
  }
});

test("a mark of another device with the same localId as a sent one stays queued", async () => {
  put("sync", queueRow([{ deviceId: OTHER, localId: 4 }, { deviceId: OWN, localId: 4 }]));
  const { settleTombstones, readTombstoneQueue } = await load();
  await settleTombstones("reader-1", [{ deviceId: OWN, localId: 4 }], "c");
  assert.deepEqual((await readTombstoneQueue("reader-1")).pending, [{ deviceId: OTHER, localId: 4 }]);
});

test("a sent mark with a localId no queued mark has drops nothing, whatever the device", async () => {
  put("sync", queueRow([{ deviceId: OWN, localId: 1 }, { deviceId: OTHER, localId: 2 }]));
  const { settleTombstones, readTombstoneQueue } = await load();
  await settleTombstones("reader-1", [{ deviceId: THIRD, localId: 1 }, { deviceId: OWN, localId: 2 }], "c");
  assert.deepEqual((await readTombstoneQueue("reader-1")).pending, [{ deviceId: OWN, localId: 1 }, { deviceId: OTHER, localId: 2 }]);
});

test("settleTombstones stores the cursor it is given, and null when given null", async () => {
  put("sync", queueRow([{ deviceId: OWN, localId: 1 }]));
  const { settleTombstones, readTombstoneQueue } = await load();
  await settleTombstones("reader-1", [], "cursor-xyz");
  assert.equal((await readTombstoneQueue("reader-1")).since, "cursor-xyz");
  await settleTombstones("reader-1", [], null);
  assert.equal((await readTombstoneQueue("reader-1")).since, null);
});

test("5 000 queued against 5 000 sent settle in under 200 ms and by one visit per sent mark", async () => {
  const size = 5000;
  // No sent mark matches: the worst case for a scan of `sent` per queued mark.
  const pending: Mark[] = Array.from({ length: size }, (_, i) => ({ deviceId: OWN, localId: i }));
  let reads = 0;
  const sent: Mark[] = Array.from({ length: size }, (_, i) => {
    const mark = { deviceId: OTHER, localId: i };
    return {
      get deviceId() { reads += 1; return mark.deviceId; },
      get localId() { reads += 1; return mark.localId; },
    };
  });
  put("sync", queueRow(pending));
  const { settleTombstones, readTombstoneQueue } = await load();
  reads = 0;
  const started = performance.now();
  await settleTombstones("reader-1", sent, "c");
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `settle took ${elapsed.toFixed(0)} ms`);
  // A keyed lookup reads each sent mark a constant number of times, never once per queued mark.
  assert.ok(reads <= size * 10, `sent marks were read ${reads} times for ${size} marks`);
  assert.equal((await readTombstoneQueue("reader-1")).pending.length, size);
});
