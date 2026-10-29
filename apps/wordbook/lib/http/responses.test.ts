// W1: the one response helper the five no-store routes share. Loaded under
// plain Node with no `server-only` stub.
import assert from "node:assert/strict";
import { test } from "node:test";

test("NO_STORE is the no-store cache header", async () => {
  const { NO_STORE } = await import("./responses");
  assert.deepEqual(NO_STORE, { "Cache-Control": "no-store" });
});

test("json answers the body, the status and no-store", async () => {
  const { json } = await import("./responses");
  const response = json({ error: "invalid" }, 400);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "invalid" });
});

test("empty answers the status with no body and no-store", async () => {
  const { empty } = await import("./responses");
  for (const status of [204, 400] as const) {
    const response = empty(status);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "");
  }
});
