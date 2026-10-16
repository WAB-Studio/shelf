// A failed read of the sync row must never be followed by a write: merging
// into a freshly minted state would persist a new deviceId.
import assert from "node:assert/strict";
import { test } from "node:test";

test("writeSyncState: when the stored row cannot be read, nothing is put", async () => {
  let puts = 0;
  const database = {
    onclose: null,
    transaction: () => {
      const transaction: {
        oncomplete: null | (() => void);
        onerror: null;
        onabort: null;
        objectStore: () => unknown;
      } = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore: () => ({
          get: () => {
            const request: {
              onsuccess: null | (() => void);
              onerror: null | (() => void);
              error: Error;
              result?: unknown;
            } = {
              onsuccess: null,
              onerror: null,
              error: new Error("read failed"),
            };
            queueMicrotask(() => request.onerror?.());
            return request;
          },
          put: () => {
            puts += 1;
            queueMicrotask(() => transaction.oncomplete?.());
          },
        }),
      };
      return transaction;
    },
  };
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const request: {
        onsuccess: null | (() => void);
        onerror: null | (() => void);
        result: unknown;
      } = {
        onsuccess: null,
        onerror: null,
        result: database,
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  const { writeSyncState } = await import("./record");
  await writeSyncState({ enabled: true });
  assert.equal(puts, 0);
});
