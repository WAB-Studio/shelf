import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { clearNavQuery, readNavQuery, writeNavQuery } from "./query-storage";

const globals = globalThis as unknown as { window?: unknown };

afterEach(() => {
  delete globals.window;
});

function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  globals.window = {
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  };
  return store;
}

test("a written query reads back; an empty one clears it", () => {
  const store = installStorage();
  writeNavQuery("snuff");
  assert.equal(readNavQuery(), "snuff");
  assert.equal(store.get("voyager:nav-query"), "snuff");
  writeNavQuery("");
  assert.equal(readNavQuery(), "");
  assert.equal(store.size, 0);
});

test("clearNavQuery removes the stored query", () => {
  installStorage();
  writeNavQuery("frisk");
  clearNavQuery();
  assert.equal(readNavQuery(), "");
});

test("storage that throws reads as empty and writes swallow the error", () => {
  const refuse = () => {
    throw new Error("SecurityError");
  };
  globals.window = { sessionStorage: { getItem: refuse, setItem: refuse, removeItem: refuse } };
  assert.equal(readNavQuery(), "");
  assert.doesNotThrow(() => writeNavQuery("x"));
  assert.doesNotThrow(() => writeNavQuery(""));
  assert.doesNotThrow(() => clearNavQuery());
});

test("outside a browser every function does nothing", () => {
  assert.equal(readNavQuery(), "");
  assert.doesNotThrow(() => writeNavQuery("x"));
});
