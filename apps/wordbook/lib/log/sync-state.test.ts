// RL-24, RL-55: the copy's state belongs to one reader on one live device.
import assert from "node:assert/strict";
import { test } from "node:test";

import { isOtherReader, normaliseSyncState, signOutSyncState, syncStateForReader } from "./sync-state";
import type { SyncState } from "./types";

function state(overrides: Partial<SyncState> = {}): SyncState {
  return {
    deviceId: "device-old",
    pushedThroughLocalId: 12,
    pulledThroughCursor: "a|b|3",
    lastSyncedAt: 1_700_000_000_000,
    enabled: false,
    readerId: "A",
    retired: false,
    ...overrides,
  };
}

const mint = () => "device-new";

test("normaliseSyncState: a row from before readerId and retired reads unclaimed and live", () => {
  const old = {
    deviceId: "d",
    pushedThroughLocalId: 4,
    pulledThroughCursor: "c",
    lastSyncedAt: 5,
    enabled: true,
  };
  assert.deepEqual(normaliseSyncState(old), { ...old, readerId: null, retired: false });
});

test("syncStateForReader: the same reader keeps device and both cursors", () => {
  const next = syncStateForReader(state(), "A", mint, null);
  assert.equal(next.deviceId, "device-old");
  assert.equal(next.pushedThroughLocalId, 12);
  assert.equal(next.pulledThroughCursor, "a|b|3");
  assert.equal(next.enabled, true);
});

test("syncStateForReader: another reader starts over under a new device", () => {
  const next = syncStateForReader(state(), "B", mint, null);
  assert.equal(next.deviceId, "device-new");
  assert.equal(next.pushedThroughLocalId, null);
  assert.equal(next.pulledThroughCursor, null);
  assert.equal(next.readerId, "B");
  assert.equal(next.enabled, true);
});

test("syncStateForReader: cursors from before readerId was recorded start over", () => {
  const next = syncStateForReader(state({ readerId: null }), "A", mint, null);
  assert.equal(next.deviceId, "device-new");
  assert.equal(next.pushedThroughLocalId, null);
  assert.equal(next.pulledThroughCursor, null);
});

test("syncStateForReader: an unclaimed state with no cursors keeps its device", () => {
  const next = syncStateForReader(state({ readerId: null, pushedThroughLocalId: null, pulledThroughCursor: null }), "A", mint, null);
  assert.equal(next.deviceId, "device-old");
  assert.equal(next.readerId, "A");
});

test("syncStateForReader: a retired device starts over even for the same reader", () => {
  const next = syncStateForReader(state({ retired: true, enabled: false }), "A", mint, null);
  assert.equal(next.deviceId, "device-new");
  assert.equal(next.retired, false);
  assert.equal(next.pushedThroughLocalId, null);
  assert.equal(next.enabled, true);
});

test("signOutSyncState: a live device only turns the copy off and keeps everything else", () => {
  const next = signOutSyncState(state({ enabled: true }), mint);
  assert.deepEqual(next, state({ enabled: false }));
});

test("signOutSyncState: a retired device forgets its identity and cursors but keeps the reader", () => {
  const next = signOutSyncState(state({ retired: true, enabled: false }), mint);
  assert.equal(next.deviceId, "device-new");
  assert.equal(next.pushedThroughLocalId, null);
  assert.equal(next.pulledThroughCursor, null);
  assert.equal(next.lastSyncedAt, null);
  assert.equal(next.retired, false);
  assert.equal(next.readerId, "A");
  assert.equal(next.enabled, false);
});

test("normaliseSyncState: a stored readerId is kept", () => {
  assert.equal(normaliseSyncState({ deviceId: "d", readerId: "A" }).readerId, "A");
});

test("normaliseSyncState: a row without enabled reads as the copy off", () => {
  assert.equal(normaliseSyncState({ deviceId: "d" }).enabled, false);
});

test("isOtherReader: another reader, the same one, and unclaimed states with and without cursors", () => {
  assert.equal(isOtherReader(state({ readerId: "A" }), "B"), true);
  assert.equal(isOtherReader(state({ readerId: "A" }), "A"), false);
  assert.equal(isOtherReader(state({ readerId: null, pushedThroughLocalId: null, pulledThroughCursor: null }), "A"), false);
  assert.equal(isOtherReader(state({ readerId: null }), "A"), true);
});

test("isOtherReader: a single cursor is enough to make an unclaimed state another reader's", () => {
  assert.equal(isOtherReader(state({ readerId: null, pushedThroughLocalId: 3, pulledThroughCursor: null }), "A"), true);
  assert.equal(isOtherReader(state({ readerId: null, pushedThroughLocalId: null, pulledThroughCursor: "c" }), "A"), true);
});

test("syncStateForReader: another reader's copy leaves everything already stored behind", () => {
  const next = syncStateForReader(state(), "B", mint, 7);
  assert.equal(next.deviceId, "device-new");
  assert.equal(next.pushedThroughLocalId, 7);
  assert.equal(next.pulledThroughCursor, null);
  assert.equal(next.readerId, "B");
});

test("syncStateForReader: cursors with no reader are another reader's", () => {
  const next = syncStateForReader(state({ readerId: null }), "A", mint, 4);
  assert.equal(next.deviceId, "device-new");
  assert.equal(next.pushedThroughLocalId, 4);
});

test("syncStateForReader: a single cursor with no reader is another reader's", () => {
  const next = syncStateForReader(state({ readerId: null, pulledThroughCursor: null }), "A", mint, 4);
  assert.equal(next.deviceId, "device-new");
  assert.equal(next.pushedThroughLocalId, 4);
});

test("syncStateForReader: the first reader keeps the device and uploads what was there", () => {
  const next = syncStateForReader(state({ readerId: null, pushedThroughLocalId: null, pulledThroughCursor: null }), "A", mint, 9);
  assert.equal(next.deviceId, "device-old");
  assert.equal(next.pushedThroughLocalId, null);
});

test("syncStateForReader: a retired device copies as a new one, uploading everything", () => {
  const next = syncStateForReader(state({ retired: true }), "A", mint, 9);
  assert.equal(next.deviceId, "device-new");
  assert.equal(next.pushedThroughLocalId, null);
  assert.equal(next.retired, false);
});
