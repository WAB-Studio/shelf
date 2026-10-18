import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { askToKeepStorage, storageKept } from "./persist";

const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function stubNavigator(value: unknown) {
  Object.defineProperty(globalThis, "navigator", { value, configurable: true });
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "navigator", original);
  else Reflect.deleteProperty(globalThis, "navigator");
});

test("absent API reports null and never throws", async () => {
  stubNavigator({});
  assert.equal(await storageKept(), null);
  assert.equal(await askToKeepStorage(), null);
});

test("storageKept reads persisted() without asking", async () => {
  let asked = 0;
  stubNavigator({ storage: { persisted: async () => true, persist: async () => (asked++, false) } });
  assert.equal(await storageKept(), true);
  assert.equal(asked, 0);
});

test("askToKeepStorage returns persist() once per call, granted or refused", async () => {
  let calls = 0;
  stubNavigator({ storage: { persisted: async () => false, persist: async () => (calls++, true) } });
  assert.equal(await askToKeepStorage(), true);
  assert.equal(calls, 1);
  stubNavigator({ storage: { persisted: async () => true, persist: async () => false } });
  assert.equal(await askToKeepStorage(), false);
});

test("a rejecting API reports null", async () => {
  const boom = async () => {
    throw new Error("denied");
  };
  stubNavigator({ storage: { persisted: boom, persist: boom } });
  assert.equal(await storageKept(), null);
  assert.equal(await askToKeepStorage(), null);
});
