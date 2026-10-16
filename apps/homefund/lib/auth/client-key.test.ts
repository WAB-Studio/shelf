import assert from "node:assert/strict";
import test from "node:test";

import { addressKey, callerKey } from "./client-key";

const SALT = "a-salt-of-sixteen-chars";
const headers = (init: Record<string, string>) => new Headers(init);

test("the caller key takes the first forwarded hop", () => {
  const key = callerKey(headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }), SALT);
  assert.equal(key, callerKey(headers({ "x-forwarded-for": "1.1.1.1" }), SALT));
});

test("the real IP serves when nothing is forwarded", () => {
  assert.equal(
    callerKey(headers({ "x-real-ip": "3.3.3.3" }), SALT),
    callerKey(headers({ "x-forwarded-for": "3.3.3.3" }), SALT),
  );
});

// Mutation: fall back to a constant key.
test("no forwarding header yields no key", () => {
  assert.equal(callerKey(headers({}), SALT), null);
});

// Mutation: drop toLowerCase() or trim().
test("case and spaces never split an address key", () => {
  assert.equal(addressKey(" Ana@X.com ", SALT), addressKey("ana@x.com", SALT));
});

// Mutation: ignore the salt.
test("two salts never share a key", () => {
  assert.notEqual(addressKey("ana@x.com", SALT), addressKey("ana@x.com", "another-salt-sixteen"));
  const h = headers({ "x-forwarded-for": "1.1.1.1" });
  assert.notEqual(callerKey(h, SALT), callerKey(h, "another-salt-sixteen"));
});

// Mutation: drop a prefix.
test("a caller and an address of the same string never share a key", () => {
  const same = "1.1.1.1";
  const caller = callerKey(headers({ "x-forwarded-for": same }), SALT)!;
  const address = addressKey(same, SALT);
  assert.notEqual(caller, address);
  assert.ok(caller.startsWith("signin:"));
  assert.ok(address.startsWith("signin-to:"));
});

test("two callers never share a key", () => {
  assert.notEqual(
    callerKey(headers({ "x-forwarded-for": "1.1.1.1" }), SALT),
    callerKey(headers({ "x-forwarded-for": "1.1.1.2" }), SALT),
  );
});
