import assert from "node:assert/strict";
import test from "node:test";

import { PENDING_LIFETIME_MS, clearPending, readPending, savePending } from "./pending-sign-in";

const memory = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
};
// The marker `/auth/confirm` leaves is a script-readable cookie; the record reads it from `document.cookie`.
const page = { cookie: "" };
(globalThis as { document?: unknown }).document = page;

const T0 = 1_000_000;
const MARKER = "goallog-signed-in-at";

test.beforeEach(() => {
  memory.clear();
  page.cookie = "";
});

test("a saved address is read back with the moment it was sent, within its hour", () => {
  savePending("ana@correo.test", T0);
  assert.deepEqual(readPending(T0 + 5 * 60 * 1000), { email: "ana@correo.test", at: T0 });
});

test("a second save moves the moment the countdown counts from", () => {
  savePending("ana@correo.test", T0);
  savePending("ana@correo.test", T0 + 90_000);
  assert.deepEqual(readPending(T0 + 100_000), { email: "ana@correo.test", at: T0 + 90_000 });
});

test("past the hour nothing is read, and the record is dropped", () => {
  savePending("ana@correo.test", T0);
  assert.deepEqual(readPending(T0 + PENDING_LIFETIME_MS - 1), { email: "ana@correo.test", at: T0 });
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

test("a landing marker newer than the record drops it: the code is spent", () => {
  savePending("ana@correo.test", T0);
  page.cookie = `${MARKER}=${T0 + 5_000}`;
  assert.equal(readPending(T0 + 10_000), null);
  assert.equal(memory.size, 0);
});

test("a landing marker equal to the record's moment drops it too", () => {
  savePending("ana@correo.test", T0);
  page.cookie = `${MARKER}=${T0}`;
  assert.equal(readPending(T0 + 10_000), null);
  assert.equal(memory.size, 0);
});

test("a landing marker older than the record leaves it: the code was asked for after that landing", () => {
  savePending("ana@correo.test", T0);
  page.cookie = `${MARKER}=${T0 - 1}`;
  assert.deepEqual(readPending(T0 + 10_000), { email: "ana@correo.test", at: T0 });
  assert.equal(memory.size, 1);
});

test("the marker is found among other cookies, by its exact name", () => {
  savePending("ana@correo.test", T0);
  page.cookie = `theme=dark; ${MARKER}=${T0 + 1}; locale=es`;
  assert.equal(readPending(T0 + 10_000), null);
});

test("a cookie that only ends in the marker's name is not the marker", () => {
  savePending("ana@correo.test", T0);
  page.cookie = `other-${MARKER}=${T0 + 1}`;
  assert.deepEqual(readPending(T0 + 10_000), { email: "ana@correo.test", at: T0 });
});

test("a marker that is not a number is ignored", () => {
  savePending("ana@correo.test", T0);
  page.cookie = `${MARKER}=soon`;
  assert.deepEqual(readPending(T0 + 10_000), { email: "ana@correo.test", at: T0 });
});

test("the marker alone, with no record, reads as nothing", () => {
  page.cookie = `${MARKER}=${T0}`;
  assert.equal(readPending(T0), null);
});
