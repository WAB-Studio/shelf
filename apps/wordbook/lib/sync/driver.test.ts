// The driver's two cursors, driven end to end with `./record`, `./merge` and
// `fetch` replaced by stand-ins: what is under test is the order and the
// values the driver hands them, not IndexedDB or the route.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

import { SYNC_BATCH } from "./protocol";

const DEVICE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

type Written = Record<string, unknown>;

let initialCursor: string | null = null;
let written: Written[] = [];
let requests: { since: string | null; readerId?: string }[] = [];
let refusal: { status: number; error: string } | null = null;
let responses: { rows: unknown[]; cursor: string | null }[] = [];
let mergeImpl: (rows: unknown[]) => Promise<number> = async (rows) => rows.length;

function foreignRows(count: number, from: number) {
  return Array.from({ length: count }, (_, index) => ({
    deviceId: OTHER,
    localId: from + index,
    at: 1_700_000_000_000 + index,
    text: "cat",
    normalised: "cat",
    kind: "word",
    outcome: "exact",
    headword: "cat",
    rule: null,
    senses: 1,
    translation: null,
    dictionaryReady: true,
    origin: "device",
    recordSchema: 1,
    definition: null,
    exampleEn: null,
    exampleEs: null,
    receivedAt: "2026-10-08T10:00:00.000Z",
  }));
}

const fetchStub = async (_url: unknown, init: { body: string }) => {
  const sent = JSON.parse(init.body);
  requests.push({ since: sent.since, readerId: sent.readerId });
  if (refusal) return { ok: false, status: refusal.status, json: async () => ({ error: refusal!.error }) };
  const next = responses.shift();
  assert.ok(next, "fetch called more times than the test queued responses");
  return { ok: true, status: 200, json: async () => ({ accepted: 0, ...next }) };
};

type Driver = typeof import("./driver");
let driver: Driver | null = null;

async function getDriver(): Promise<Driver> {
  if (driver) return driver;
  Object.assign(globalThis, { fetch: fetchStub, window: { dispatchEvent: () => true } });
  mock.module("../log/record", {
    namedExports: {
      readSyncState: async () => ({
        enabled: true,
        readerId: "reader-1",
        deviceId: DEVICE,
        pushedThroughLocalId: null,
        pulledThroughCursor: initialCursor,
      }),
      writeSyncState: async (next: Written) => void written.push(next),
      markRetired: async () => undefined,
    },
  });
  mock.module("../log/merge", {
    namedExports: {
      readSince: async () => ({ own: [], scannedThrough: null, scanned: 0 }),
      mergeForeign: (rows: unknown[]) => mergeImpl(rows),
    },
  });
  driver = await import("./driver");
  return driver;
}

beforeEach(() => {
  initialCursor = null;
  written = [];
  requests = [];
  responses = [];
  refusal = null;
  mergeImpl = async (rows) => rows.length;
});

test("a full download page moves the cursor: the next request resumes from it", async () => {
  responses = [
    { rows: foreignRows(SYNC_BATCH, 1), cursor: "c1" },
    { rows: foreignRows(3, SYNC_BATCH + 1), cursor: "c2" },
  ];
  const outcome = await (await getDriver()).syncNow();
  assert.deepEqual(requests.map((request) => request.since), [null, "c1"]);
  assert.deepEqual(outcome, { kind: "done", pushed: 0, pulled: SYNC_BATCH + 3 });
  assert.equal(written.at(-1)?.pulledThroughCursor, "c2");
});

test("a merge that fails leaves the new cursor unwritten", async () => {
  responses = [{ rows: foreignRows(2, 1), cursor: "c1" }];
  mergeImpl = () => Promise.reject(new Error("quota"));
  const outcome = await (await getDriver()).syncNow();
  assert.equal(outcome.kind, "failed");
  assert.deepEqual(written, []);
});

test("the cursor is written only after the merge has landed", async () => {
  responses = [{ rows: foreignRows(2, 1), cursor: "c1" }];
  const order: string[] = [];
  mergeImpl = async (rows) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push("merged");
    return rows.length;
  };
  const write = written.push.bind(written);
  written.push = (...items) => (order.push("written"), write(...items));
  await (await getDriver()).syncNow();
  assert.deepEqual(order, ["merged", "written"]);
});

test("two calls at once share one round trip", async () => {
  responses = [{ rows: [], cursor: null }];
  const [a, b] = await Promise.all([(await getDriver()).syncNow(), (await getDriver()).syncNow()]);
  assert.equal(requests.length, 1);
  assert.deepEqual(a, b);
});

test("every round names the reader it syncs for", async () => {
  responses = [{ rows: [], cursor: null }];
  await (await getDriver()).syncNow();
  assert.equal(requests[0].readerId, "reader-1");
});

test("a 409 for the reader drops the identity, writes no cursor and stops", async () => {
  refusal = { status: 409, error: "reader" };
  const outcome = await (await getDriver()).syncNow();
  assert.deepEqual(outcome, { kind: "reader" });
  assert.deepEqual(written, [{ enabled: false, readerId: null }]);
  assert.equal(requests.length, 1);
});

test("rounds run under the voyager-sync lock when the browser has one", async () => {
  const held: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      onLine: true,
      locks: { request: (name: string, run: () => Promise<unknown>) => (held.push(name), run()) },
    },
  });
  try {
    responses = [{ rows: [], cursor: null }];
    await (await getDriver()).syncNow();
    assert.deepEqual(held, ["voyager-sync"]);
  } finally {
    delete (globalThis as { navigator?: unknown }).navigator;
  }
});
