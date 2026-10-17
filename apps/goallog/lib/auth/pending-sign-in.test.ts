import assert from "node:assert/strict";
import test from "node:test";

import { PENDING_LIFETIME_MS, clearPending, readPending, savePending } from "./pending-sign-in";

const memory = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
};

const T0 = 1_000_000;

test("a saved address is read back within its hour", () => {
  savePending("ana@correo.test", T0);
  assert.equal(readPending(T0 + 5 * 60 * 1000), "ana@correo.test");
  clearPending();
});

test("past the hour nothing is read, and the record is dropped", () => {
  savePending("ana@correo.test", T0);
  assert.equal(readPending(T0 + PENDING_LIFETIME_MS - 1), "ana@correo.test");
  assert.equal(readPending(T0 + PENDING_LIFETIME_MS), null);
  assert.equal(memory.size, 0);
});

test("clearing forgets the address", () => {
  savePending("ana@correo.test", T0);
  clearPending();
  assert.equal(readPending(T0), null);
});

test("unreadable or misshapen records read as nothing and are dropped", () => {
  memory.set("goallog.pending-sign-in", "{not json");
  assert.equal(readPending(T0), null);
  memory.set("goallog.pending-sign-in", JSON.stringify({ email: 7, at: "x" }));
  assert.equal(readPending(T0), null);
  assert.equal(memory.size, 0);
});

test("a record stamped in the future is not trusted", () => {
  savePending("ana@correo.test", T0 + 10_000);
  assert.equal(readPending(T0), null);
});
