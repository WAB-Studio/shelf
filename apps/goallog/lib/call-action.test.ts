import assert from "node:assert/strict";
import { test } from "node:test";
import { callAction } from "./call-action";

const failed = { ok: false, error: "tree.note.failed" };

test("a success passes through as the same object", async () => {
  const success = { ok: true, id: "x" };
  assert.equal(await callAction(async () => success), success);
});

test("a refusal passes through untouched", async () => {
  const refusal = { ok: false as const, error: "plan.errors.notFound" };
  assert.equal(await callAction(async () => refusal), refusal);
});

test("a rejection becomes the failed refusal", async () => {
  assert.deepEqual(await callAction(() => Promise.reject(new TypeError("fetch"))), failed);
});

test("a synchronous throw becomes the failed refusal", async () => {
  assert.deepEqual(await callAction((() => { throw new Error("boom"); }) as () => Promise<{ ok: boolean }>), failed);
});

test("the error's message is never logged", async () => {
  const seen: unknown[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...args: unknown[]) => void seen.push(args);
  try {
    await callAction(() => Promise.reject(new Error("secret note text")));
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(seen, []);
});
