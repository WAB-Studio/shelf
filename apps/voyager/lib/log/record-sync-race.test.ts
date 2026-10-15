// The `sync` row under two tabs: a small in-memory IndexedDB that runs
// transactions one at a time, as the browser does. Tab B is played by editing
// the fake's store directly while this realm holds whatever it read before.
import assert from "node:assert/strict";
import { test } from "node:test";

type Row = Record<string, unknown>;
const store = new Map<string, Row>();

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
let tail: Promise<void> = Promise.resolve();

function fakeTransaction() {
  const ops: (() => void)[] = [];
  const transaction: { oncomplete: null | (() => void); onerror: null; onabort: null; objectStore: () => unknown } = {
    oncomplete: null,
    onerror: null,
    onabort: null,
    objectStore: () => ({
      get: (key: string) => {
        const request: { result?: unknown; onsuccess: null | (() => void) } = { onsuccess: null };
        ops.push(() => {
          const found = store.get(key);
          request.result = found && structuredClone(found);
          request.onsuccess?.();
        });
        return request;
      },
      openCursor: () => {
        const request: { result: null; onsuccess: null | (() => void) } = { result: null, onsuccess: null };
        ops.push(() => request.onsuccess?.());
        return request;
      },
      put: (row: Row) => {
        ops.push(() => void store.set(row.key as string, structuredClone(row)));
      },
    }),
  };
  tail = tail.then(async () => {
    await tick();
    while (ops.length) {
      ops.shift()!();
      await tick();
    }
    transaction.oncomplete?.();
  });
  return transaction;
}

(globalThis as { indexedDB?: unknown }).indexedDB = {
  open: () => {
    const request: { onsuccess: null | (() => void); onerror: null; result: unknown } = {
      onsuccess: null,
      onerror: null,
      result: { onclose: null, onversionchange: null, transaction: fakeTransaction },
    };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  },
};

const R = "reader-r";
const R2 = "reader-r2";
const stored = () => store.get("state") as Row;

test("a tab never writes back an identity another tab has already replaced", async () => {
  const { readSyncState, writeSyncState } = await import("./record");
  store.clear();
  await writeSyncState({ enabled: true, readerId: R });
  assert.equal((await readSyncState()).readerId, R);

  // Tab B: R signs out and R2 signs in, behind this realm's back.
  store.set("state", { ...stored(), enabled: false, readerId: R2 });

  await writeSyncState({ pushedThroughLocalId: 9 });
  assert.equal(stored().readerId, R2);
  assert.equal(stored().enabled, false);
  assert.equal(stored().pushedThroughLocalId, 9);
});

test("two concurrent writes keep both fields", async () => {
  const { writeSyncState } = await import("./record");
  store.clear();
  await writeSyncState({ enabled: true });
  await Promise.all([writeSyncState({ pushedThroughLocalId: 5 }), writeSyncState({ pulledThroughCursor: "c" })]);
  assert.equal(stored().pushedThroughLocalId, 5);
  assert.equal(stored().pulledThroughCursor, "c");
});

test("concurrent first reads mint one deviceId, and a row written elsewhere is read, not cached over", async () => {
  const { readSyncState } = await import("./record");
  store.clear();
  const [a, b] = await Promise.all([readSyncState(), readSyncState()]);
  assert.equal(a.deviceId, b.deviceId);
  store.set("state", { ...stored(), deviceId: "device-from-tab-b" });
  assert.equal((await readSyncState()).deviceId, "device-from-tab-b");
});

test("startCopyFor decides from the row as the transaction reads it", async () => {
  const { startCopyFor, writeSyncState } = await import("./record");
  store.clear();
  await writeSyncState({ enabled: true, readerId: R, pushedThroughLocalId: 4 });
  const fresh = await startCopyFor(R2);
  assert.equal(fresh.readerId, R2);
  assert.notEqual(fresh.pushedThroughLocalId, 4);
  assert.equal((stored() as { readerId: string }).readerId, R2);
});
