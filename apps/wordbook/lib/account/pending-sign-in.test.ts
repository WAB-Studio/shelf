import assert from "node:assert/strict";
import test from "node:test";

import { PENDING_LIFETIME_MS, clearPending, readPending, savePending } from "./pending-sign-in";

// D5 (RL-73): the address a code was asked for stays on the device for the
// code's hour, under one key, so a reload or a relaunch reopens the code step.
const memory = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
};

const T0 = 1_000_000;
const MINUTE = 60_000;

test("the lifetime is the hour the mailed code lasts", () => {
  assert.equal(PENDING_LIFETIME_MS, 60 * MINUTE);
});

test("a saved address is read back at minute 5, exactly as typed", () => {
  savePending("Ana.Lopez+x@correo.test", T0);
  assert.equal(readPending(T0 + 5 * MINUTE), "Ana.Lopez+x@correo.test");
  clearPending();
});

test("the address lives under one key", () => {
  memory.clear();
  savePending("ana@correo.test", T0);
  assert.equal(memory.size, 1);
  savePending("otra@correo.test", T0 + MINUTE);
  assert.equal(memory.size, 1);
  assert.equal(readPending(T0 + MINUTE), "otra@correo.test");
  clearPending();
});

test("it is still there one millisecond before the hour and gone at the hour", () => {
  savePending("ana@correo.test", T0);
  assert.equal(readPending(T0 + 60 * MINUTE - 1), "ana@correo.test");
  assert.equal(readPending(T0 + 60 * MINUTE), null);
});

test("an expired record is dropped, not left behind", () => {
  memory.clear();
  savePending("ana@correo.test", T0);
  assert.equal(readPending(T0 + 61 * MINUTE), null);
  assert.equal(memory.size, 0);
});

test("clearing forgets the address and leaves other keys alone", () => {
  memory.clear();
  memory.set("something.else", "kept");
  savePending("ana@correo.test", T0);
  clearPending();
  assert.equal(readPending(T0), null);
  assert.equal(memory.get("something.else"), "kept");
  assert.equal(memory.size, 1);
});

test("nothing stored reads as nothing", () => {
  memory.clear();
  assert.equal(readPending(T0), null);
});

test("an unreadable or misshapen record reads as nothing", () => {
  savePending("ana@correo.test", T0);
  const [key] = [...memory.keys()];
  memory.set(key, "{not json");
  assert.equal(readPending(T0), null);

  savePending("ana@correo.test", T0);
  memory.set(key, JSON.stringify({ email: 7, at: "x" }));
  assert.equal(readPending(T0), null);
});

test("a record stamped in the future is not trusted", () => {
  memory.clear();
  savePending("ana@correo.test", T0 + 10 * MINUTE);
  assert.equal(readPending(T0), null);
});

test("storage that throws neither saves nor breaks the screen", () => {
  const saved = (globalThis as { localStorage?: unknown }).localStorage;
  const broken = () => {
    throw new Error("denied");
  };
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: broken, setItem: broken, removeItem: broken };
  try {
    assert.doesNotThrow(() => savePending("ana@correo.test", T0));
    assert.equal(readPending(T0), null);
    assert.doesNotThrow(() => clearPending());
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = saved;
  }
});
