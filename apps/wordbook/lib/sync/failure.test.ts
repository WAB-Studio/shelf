import assert from "node:assert/strict";
import { test } from "node:test";

import { failureCause } from "./failure";

test("a 429 that names the quota is quota", () => {
  assert.equal(failureCause({ status: 429, body: { error: "quota" } }), "quota");
});

test("a 429 without the quota body is server", () => {
  assert.equal(failureCause({ status: 429, body: {} }), "server");
  assert.equal(failureCause({ status: 429, body: null }), "server");
});

test("a failed fetch, or a device known offline, is offline", () => {
  assert.equal(failureCause({ error: new TypeError("Failed to fetch"), online: true }), "offline");
  assert.equal(failureCause({ error: new Error("x"), online: false }), "offline");
});

test("any other status, or an unreadable body, is server", () => {
  assert.equal(failureCause({ status: 500, body: null }), "server");
  assert.equal(failureCause({ status: 400, body: {} }), "server");
  assert.equal(failureCause({ error: new Error("bad body"), online: true }), "server");
});
