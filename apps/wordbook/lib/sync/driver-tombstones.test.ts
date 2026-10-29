// RL-66 (device half), RL-70: a sync round sends this reader's queued marks and
// the mark cursor, applies the marks the account answers with, and only then
// settles the queue and the cursor. Written from the contract, with
// `../log/record`, `../log/merge`, `../log/delete` and `fetch` replaced by
// stand-ins: what is under test is what the driver hands them and when.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

import { SYNC_BATCH, type Tombstone } from "./protocol";

const DEVICE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const mark = (localId: number, deviceId = DEVICE): Tombstone => ({ deviceId, localId });
const marks = (count: number, from: number, deviceId = OTHER): Tombstone[] =>
  Array.from({ length: count }, (_, i) => mark(from + i, deviceId));

type Round = { rows?: unknown[]; cursor?: string | null; tombstones?: Tombstone[]; tombstoneCursor?: string | null };
type Sent = { tombstones: Tombstone[]; tombstonesSince: string | null; since: string | null };

let queue: { readerId: string; mark: Tombstone }[] = [];
let since: string | null = null;
let responses: Round[] = [];
let sent: Sent[] = [];
let calls: string[] = [];
let queueReadsFor: unknown[] = [];
let settled: { readerId: string; sent: Tombstone[]; cursor: string | null }[] = [];
let applied: { marks: Tombstone[]; own: string }[] = [];
let appliedCount = 0;
let events: string[] = [];
let failure: "status" | "throw" | null = null;
let applyImpl: () => Promise<number> = async () => appliedCount;
let mergeImpl: (rows: unknown[]) => Promise<number> = async (rows) => rows.length;
const LOG_DELETED_EVENT = "test:log-deleted"; // stands in for the constant of `../log/delete`
let wire = false; // when set, the reply is the raw object, without the optional fields

const fetchStub = async (_url: unknown, init: { body: string }) => {
  const body = JSON.parse(init.body);
  sent.push({ tombstones: body.tombstones, tombstonesSince: body.tombstonesSince, since: body.since });
  calls.push("fetch");
  if (failure === "status") return { ok: false, status: 500, json: async () => ({}) };
  if (failure === "throw") throw new TypeError("network");
  const next = responses.shift();
  assert.ok(next, "fetch called more times than the test queued responses");
  const reply = wire ? next : { accepted: 0, rows: [], cursor: null, ...next };
  return { ok: true, status: 200, json: async () => ({ accepted: 0, ...reply }) };
};

type Driver = typeof import("./driver");
let driver: Driver | null = null;

async function getDriver(): Promise<Driver> {
  if (driver) return driver;
  Object.assign(globalThis, {
    fetch: fetchStub,
    window: { dispatchEvent: (event: Event) => (events.push(event.type), true) },
  });
  mock.module("../log/record", {
    namedExports: {
      readSyncState: async () => ({
        enabled: true, readerId: "R", deviceId: DEVICE, pushedThroughLocalId: null, pulledThroughCursor: null,
      }),
      writeSyncState: async () => undefined,
      markRetired: async () => undefined,
    },
  });
  mock.module("../log/merge", {
    namedExports: {
      readSince: async () => ({ own: [], scannedThrough: null, scanned: 0 }),
      mergeForeign: async (rows: unknown[]) => (calls.push("merge"), mergeImpl(rows)),
    },
  });
  mock.module("../log/delete", {
    namedExports: {
      LOG_DELETED_EVENT,
      readTombstoneQueue: async (readerId: string) => {
        queueReadsFor.push(readerId);
        return { pending: queue.filter((e) => e.readerId === readerId).map((e) => e.mark), since };
      },
      settleTombstones: async (readerId: string, done: Tombstone[], cursor: string | null) => {
        calls.push("settle");
        settled.push({ readerId, sent: done, cursor });
        const gone = new Set(done.map((m) => `${m.deviceId}/${m.localId}`));
        queue = queue.filter((e) => e.readerId !== readerId || !gone.has(`${e.mark.deviceId}/${e.mark.localId}`));
        since = cursor;
      },
      applyTombstones: async (got: Tombstone[], own: string) => {
        calls.push("apply");
        applied.push({ marks: got, own });
        return applyImpl();
      },
    },
  });
  driver = await import("./driver");
  return driver;
}

function wireRows(count: number, from: number) {
  return Array.from({ length: count }, (_, i) => ({
    deviceId: OTHER, localId: from + i, at: 1_700_000_000_000, text: "cat", normalised: "cat", kind: "word",
    outcome: "exact", headword: "cat", rule: null, senses: 1, translation: null, dictionaryReady: true,
    origin: "device", recordSchema: 1, definition: null, exampleEn: null, exampleEs: null,
    receivedAt: "2026-10-08T10:00:00.000Z",
  }));
}

beforeEach(() => {
  queue = [];
  since = null;
  responses = [];
  sent = [];
  calls = [];
  queueReadsFor = [];
  settled = [];
  applied = [];
  appliedCount = 0;
  events = [];
  failure = null;
  wire = false;
  applyImpl = async () => appliedCount;
  mergeImpl = async (rows) => rows.length;
});

test("marks go up for this reader only: another reader's queue never travels", async () => {
  queue = [
    { readerId: "R", mark: mark(1) },
    { readerId: "R2", mark: mark(2) },
    { readerId: "R", mark: mark(3, OTHER) },
  ];
  responses = [{}];
  await (await getDriver()).syncNow();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].tombstones, [mark(1), mark(3, OTHER)]);
  assert.deepEqual(queueReadsFor, ["R"]);
  assert.deepEqual(settled.map((s) => s.sent), [[mark(1), mark(3, OTHER)]]);
});

test("a round with nothing queued sends an empty list and the stored cursor, not nothing", async () => {
  since = "t0";
  responses = [{}];
  await (await getDriver()).syncNow();
  assert.deepEqual(sent[0].tombstones, []);
  assert.equal(sent[0].tombstonesSince, "t0");
});

test("a failed round keeps the queue and the cursor: a 500 settles and applies nothing", async () => {
  queue = [{ readerId: "R", mark: mark(1) }];
  since = "t0";
  failure = "status";
  const outcome = await (await getDriver()).syncNow();
  assert.equal(outcome.kind, "failed");
  assert.deepEqual(settled, []);
  assert.deepEqual(applied, []);
  assert.equal(queue.length, 1);
  assert.equal(since, "t0");
});

test("a request that never arrives keeps the queue as well", async () => {
  queue = [{ readerId: "R", mark: mark(1) }];
  failure = "throw";
  assert.equal((await (await getDriver()).syncNow()).kind, "failed");
  assert.deepEqual(settled, []);
  assert.equal(queue.length, 1);
});

test("marks that cannot be applied leave the queue and the cursor where they were", async () => {
  queue = [{ readerId: "R", mark: mark(1) }];
  responses = [{ tombstones: [mark(5, OTHER)], tombstoneCursor: "t1" }];
  applyImpl = () => Promise.reject(new Error("quota"));
  const outcome = await (await getDriver()).syncNow();
  assert.equal(outcome.kind, "failed");
  assert.deepEqual(settled, []);
  assert.equal(queue.length, 1);
});

test("the round merges rows, applies the marks, and only then settles", async () => {
  queue = [{ readerId: "R", mark: mark(1) }];
  responses = [{ rows: wireRows(2, 1), cursor: "c1", tombstones: [mark(5, OTHER)], tombstoneCursor: "t1" }];
  await (await getDriver()).syncNow();
  assert.deepEqual(calls, ["fetch", "merge", "apply", "settle"]);
  assert.deepEqual(applied, [{ marks: [mark(5, OTHER)], own: DEVICE }]);
  assert.deepEqual(settled, [{ readerId: "R", sent: [mark(1)], cursor: "t1" }]);
});

test("the mark cursor travels: the next round sends the cursor the last one returned", async () => {
  since = "t0";
  responses = [
    { tombstones: marks(SYNC_BATCH, 1), tombstoneCursor: "t1" },
    { tombstones: marks(2, SYNC_BATCH + 1), tombstoneCursor: "t2" },
  ];
  await (await getDriver()).syncNow();
  assert.deepEqual(sent.map((s) => s.tombstonesSince), ["t0", "t1"]);
  assert.equal(since, "t2");
});

test("the mark cursor outlives the call: the next call starts from where this one settled", async () => {
  responses = [{ tombstoneCursor: "t9" }, {}];
  const { syncNow } = await getDriver();
  await syncNow();
  await syncNow();
  assert.deepEqual(sent.map((s) => s.tombstonesSince), [null, "t9"]);
});

test("a full page of marks asks again, even when no row came down", async () => {
  responses = [
    { rows: [], tombstones: marks(SYNC_BATCH, 1), tombstoneCursor: "t1" },
    { rows: [], tombstones: [], tombstoneCursor: "t1" },
  ];
  const outcome = await (await getDriver()).syncNow();
  assert.equal(outcome.kind, "done");
  assert.equal(sent.length, 2);
});

test("a short page of marks ends the call", async () => {
  responses = [{ tombstones: marks(SYNC_BATCH - 1, 1), tombstoneCursor: "t1" }];
  await (await getDriver()).syncNow();
  assert.equal(sent.length, 1);
});

test("marks still queued past one page go in the next round, SYNC_BATCH at a time", async () => {
  queue = Array.from({ length: SYNC_BATCH + 1 }, (_, i) => ({ readerId: "R", mark: mark(i + 1) }));
  responses = [{}, {}];
  const outcome = await (await getDriver()).syncNow();
  assert.equal(outcome.kind, "done");
  assert.deepEqual(sent.map((s) => s.tombstones.length), [SYNC_BATCH, 1]);
  assert.deepEqual(sent[1].tombstones, [mark(SYNC_BATCH + 1)]);
  assert.equal(queue.length, 0);
});

test("the landed event fires when marks alone removed rows", async () => {
  const { syncNow, SYNC_LANDED_EVENT } = await getDriver();
  responses = [{ tombstones: [mark(5, OTHER)], tombstoneCursor: "t1" }];
  appliedCount = 1;
  await syncNow();
  assert.deepEqual(events, [SYNC_LANDED_EVENT]);
});

test("the landed event still fires for rows alone", async () => {
  const { syncNow, SYNC_LANDED_EVENT } = await getDriver();
  responses = [{ rows: wireRows(1, 1), cursor: "c1" }];
  await syncNow();
  assert.deepEqual(events, [SYNC_LANDED_EVENT]);
});

test("a round that brought no row and no mark announces nothing", async () => {
  responses = [{}];
  await (await getDriver()).syncNow();
  assert.deepEqual(events, []);
});

test("a server that answers without the mark fields still parses and ends cleanly", async () => {
  wire = true;
  queue = [{ readerId: "R", mark: mark(1) }];
  responses = [{ accepted: 0, rows: [], cursor: null } as Round];
  const outcome = await (await getDriver()).syncNow();
  assert.deepEqual(outcome, { kind: "done", pushed: 0, pulled: 0 });
  assert.equal(sent.length, 1);
});

test("a null mark cursor in the answer keeps the stored one", async () => {
  since = "t0";
  responses = [{ tombstoneCursor: null }];
  await (await getDriver()).syncNow();
  assert.deepEqual(settled.map((s) => s.cursor), ["t0"]);
  assert.equal(since, "t0");
});

// Stands in for React's effect so the component's listener can be driven without a DOM.
test("a delete after a failed round sends one request, not a second for the mark still queued", async () => {
  const listeners: Record<string, () => void> = {};
  Object.assign(globalThis.window, {
    addEventListener: (type: string, fn: () => void) => void (listeners[type] = fn),
    removeEventListener: () => undefined,
  });
  mock.module("react", {
    namedExports: { useEffect: (effect: () => void) => void effect() },
    defaultExport: {},
  });
  await getDriver();
  const { SyncOnDelete } = await import("../../components/sync/sync-on-delete");
  SyncOnDelete();
  assert.ok(listeners[LOG_DELETED_EVENT], "the component listens for the delete event");
  queue = [{ readerId: "R", mark: mark(1) }];
  failure = "status";
  listeners[LOG_DELETED_EVENT]();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent.length, 1);
});
