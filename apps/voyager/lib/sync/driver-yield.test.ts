// RNL-09 / module 696: the driver lets the event loop run between the
// response and the merge, and again at the end of every round. A ticker
// that advances once per macrotask stands for "the page got a turn".
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { SYNC_BATCH } from "./protocol";

const DEVICE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

let ticks = 0;
let running = false;
function startTicker(): void {
  ticks = 0;
  running = true;
  // Both queues, so a yield through either one finds a tick already waiting
  // ahead of it: a timer and an immediate fire in different loop phases.
  const viaImmediate = () => {
    if (!running) return;
    ticks += 1;
    setImmediate(viaImmediate);
  };
  const viaTimer = () => {
    if (!running) return;
    ticks += 1;
    setTimeout(viaTimer, 0);
  };
  setImmediate(viaImmediate);
  setTimeout(viaTimer, 0);
}

const wireRows = (count: number, from: number) =>
  Array.from({ length: count }, (_, i) => ({
    deviceId: OTHER, localId: from + i, at: 1_700_000_000_000, text: "cat", normalised: "cat", kind: "word",
    outcome: "exact", headword: "cat", rule: null, senses: 1, translation: null, dictionaryReady: true,
    origin: "device", recordSchema: 1, receivedAt: "2026-10-08T10:00:00.000Z",
    definition: null, exampleEn: null, exampleEs: null,
  }));

let responses: { rows: unknown[]; cursor: string | null }[] = [];
let onJson: () => void = () => {};
let onMerge: () => void = () => {};
let onWrite: () => void = () => {};
let onRead: () => void = () => {};

let mocked = false;
async function run() {
  if (!mocked) install();
  mocked = true;
  const { syncNow } = await import("./driver");
  try {
    return await syncNow();
  } finally {
    running = false;
  }
}

function install() {
  Object.assign(globalThis, {
    window: { dispatchEvent: () => true },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        onJson();
        return { accepted: 0, ...responses.shift()! };
      },
    }),
  });
  mock.module("../log/record", {
    namedExports: {
      readSyncState: async () => ({ enabled: true, readerId: "reader-1", deviceId: DEVICE, pushedThroughLocalId: null, pulledThroughCursor: null }),
      writeSyncState: async () => void onWrite(),
      markRetired: async () => undefined,
    },
  });
  mock.module("../log/merge", {
    namedExports: {
      readSince: async () => (onRead(), { own: [], scannedThrough: null, scanned: 0 }),
      mergeForeign: async (rows: unknown[]) => (onMerge(), rows.length),
    },
  });
}

test("RNL-09: the event loop gets a turn between the response and the merge", async () => {
  responses = [{ rows: wireRows(3, 1), cursor: "c1" }];
  let ticksAtMerge = -1;
  onJson = startTicker;
  onMerge = () => (ticksAtMerge = ticks);
  const outcome = await run();
  assert.deepEqual(outcome, { kind: "done", pushed: 0, pulled: 3 });
  assert.ok(ticksAtMerge >= 1, `the merge ran ${ticksAtMerge} macrotasks after the response`);
});

test("RNL-09: the event loop gets a turn after a round's last write, before the next round starts", async () => {
  responses = [
    { rows: wireRows(SYNC_BATCH, 1), cursor: "c1" },
    { rows: wireRows(2, SYNC_BATCH + 1), cursor: "c2" },
  ];
  let reads = 0;
  let ticksAtSecondRead = -1;
  let writes = 0;
  onJson = () => {};
  onMerge = () => {};
  onWrite = () => {
    if (++writes === 1) startTicker();
  };
  onRead = () => {
    if (++reads === 2) ticksAtSecondRead = ticks;
  };
  const outcome = await run();
  assert.deepEqual(outcome, { kind: "done", pushed: 0, pulled: SYNC_BATCH + 2 });
  assert.equal(reads, 2);
  assert.ok(ticksAtSecondRead >= 1, `round 2 began ${ticksAtSecondRead} macrotasks after round 1 wrote`);
});
