import assert from "node:assert/strict";
import { test } from "node:test";

import { inactivityVerdict, keepDaysFromClaims, LAST_SEEN_REFRESH_MS, parseLastSeen } from "./inactivity";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

test("RF-190: no limit never signs a device out, however long it sat", () => {
  assert.equal(inactivityVerdict({ lastSeen: NOW - 900 * DAY, now: NOW, days: null }), "stamp");
});

test("RF-190: a device unused for longer than the limit is signed out", () => {
  assert.equal(inactivityVerdict({ lastSeen: NOW - 8 * DAY, now: NOW, days: 7 }), "expired");
});

test("RF-190: a device unused for exactly the limit keeps its session", () => {
  assert.equal(inactivityVerdict({ lastSeen: NOW - 7 * DAY, now: NOW, days: 7 }), "stamp");
});

test("RF-190: a device with no stamp is stamped, not signed out", () => {
  assert.equal(inactivityVerdict({ lastSeen: null, now: NOW, days: 7 }), "stamp");
});

test("RF-190: a recent stamp is left alone, an older one is renewed", () => {
  assert.equal(inactivityVerdict({ lastSeen: NOW - 1000, now: NOW, days: 7 }), "fresh");
  assert.equal(inactivityVerdict({ lastSeen: NOW - LAST_SEEN_REFRESH_MS - 1, now: NOW, days: 7 }), "stamp");
});

test("RF-190: the limit is read from user_metadata, whole positive days only", () => {
  assert.equal(keepDaysFromClaims({ user_metadata: { keep_signed_in_days: 30 } }), 30);
  assert.equal(keepDaysFromClaims({ user_metadata: { keep_signed_in_days: null } }), null);
  assert.equal(keepDaysFromClaims({ user_metadata: { keep_signed_in_days: "30" } }), null);
  assert.equal(keepDaysFromClaims({ user_metadata: { keep_signed_in_days: 0 } }), null);
  assert.equal(keepDaysFromClaims({ user_metadata: { keep_signed_in_days: 1.5 } }), null);
  assert.equal(keepDaysFromClaims({}), null);
  assert.equal(keepDaysFromClaims(undefined), null);
});

test("RF-190: a stamp that is not a positive number reads as none", () => {
  assert.equal(parseLastSeen(undefined), null);
  assert.equal(parseLastSeen("abc"), null);
  assert.equal(parseLastSeen("0"), null);
  assert.equal(parseLastSeen("123"), 123);
});
