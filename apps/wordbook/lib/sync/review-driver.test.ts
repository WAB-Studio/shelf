// RL-93: the review's half of a copy round, driven with the device's store and `fetch` replaced by stand-ins:
// what is under test is what the round sends, what it merges and when it moves its cursors.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

import { SYNC_BATCH } from "./protocol";

const READER = "reader-1";
type Entry = { key: string; at: number; gone: boolean; card: unknown; sense: unknown };
const entry = (key: string, at: number, gone = false): Entry => ({ key, at, gone, card: null, sense: null });

let local: Entry[] = [];
let stored: { readerId: string | null; pushedThrough: number; cursor: string | null } = { readerId: null, pushedThrough: -1, cursor: null };
let written: (typeof stored)[] = [];
let applied: Entry[][] = [];
let requests: { readerId: string; entries: Entry[]; since: string | null }[] = [];
let answers: (Response | Error)[] = [];
let applyFails = false;

const fetchStub = async (_url: unknown, init: { body: string }) => {
  requests.push(JSON.parse(init.body));
  const next = answers.shift();
  assert.ok(next, "fetch called more times than the test queued answers");
  if (next instanceof Error) throw next;
  return next;
};
const ok = (entries: Entry[], cursor: string | null = null) => Response.json({ accepted: 0, entries, cursor });

type Driver = typeof import("./review-driver");
let driver: Driver | null = null;

async function getDriver(): Promise<Driver> {
  if (driver) return driver;
  Object.assign(globalThis, { fetch: fetchStub, indexedDB: {} });
  mock.module("../review/store", {
    namedExports: {
      readEntries: async () => local,
      readReviewSync: async () => stored,
      writeReviewSync: async (state: typeof stored) => {
        written.push(state);
        stored = state;
      },
      applyEntries: async (entries: Entry[]) => {
        if (applyFails) throw new Error("indexeddb");
        applied.push(entries);
        return entries.length;
      },
    },
  });
  driver = await import("./review-driver");
  return driver;
}

beforeEach(() => {
  local = [];
  stored = { readerId: null, pushedThrough: -1, cursor: null };
  written = [];
  applied = [];
  requests = [];
  answers = [];
  applyFails = false;
});

test("a first round sends everything, merges what comes down and keeps both cursors", async () => {
  const { syncReview } = await getDriver();
  local = [entry("b", 200), entry("a", 100)];
  answers = [ok([entry("c", 300)], "cursor-1")];
  const outcome = await syncReview(READER, 1000);
  assert.deepEqual(outcome, { kind: "done", pulled: 1 });
  assert.deepEqual(requests[0].entries.map((sent) => sent.key), ["a", "b"]);
  assert.equal(requests[0].since, null);
  assert.deepEqual(applied, [[entry("c", 300)]]);
  assert.deepEqual(written, [{ readerId: READER, pushedThrough: 200, cursor: "cursor-1" }]);
});

test("a later round sends only what is newer than the last one and echoes the cursor", async () => {
  const { syncReview } = await getDriver();
  stored = { readerId: READER, pushedThrough: 200, cursor: "cursor-1" };
  local = [entry("a", 100), entry("b", 200), entry("d", 400)];
  answers = [ok([], null)];
  await syncReview(READER, 1000);
  assert.deepEqual(requests[0].entries.map((sent) => sent.key), ["d"]);
  assert.equal(requests[0].since, "cursor-1");
  assert.deepEqual(written, [{ readerId: READER, pushedThrough: 400, cursor: "cursor-1" }]);
});

test("a review the copy last met for another reader starts over for this one", async () => {
  const { syncReview } = await getDriver();
  stored = { readerId: "someone-else", pushedThrough: 900, cursor: "theirs" };
  local = [entry("a", 100)];
  answers = [ok([])];
  await syncReview(READER, 1000);
  assert.deepEqual(requests[0].entries.map((sent) => sent.key), ["a"]);
  assert.equal(requests[0].since, null);
});

test("a full page on either side asks for the next, and a short one ends the round", async () => {
  const { syncReview } = await getDriver();
  local = Array.from({ length: SYNC_BATCH + 1 }, (_, i) => entry(`k${String(i).padStart(4, "0")}`, i + 1));
  const down = Array.from({ length: SYNC_BATCH }, (_, i) => entry(`d${i}`, 5_000 + i));
  answers = [ok(down, "page-1"), ok([entry("z", 9_000)], "page-2")];
  const outcome = await syncReview(READER, 1000);
  assert.deepEqual(outcome, { kind: "done", pulled: SYNC_BATCH + 1 });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].entries.length, SYNC_BATCH);
  assert.deepEqual(requests[1].entries.map((sent) => sent.key), ["k0500"]);
  assert.equal(requests[1].since, "page-1");
});

test("no session is not a failure, and nothing moves", async () => {
  const { syncReview } = await getDriver();
  local = [entry("a", 100)];
  answers = [Response.json({ error: "unauthorized" }, { status: 401 })];
  assert.deepEqual(await syncReview(READER, 1000), { kind: "done", pulled: 0 });
  assert.deepEqual(written, []);
});

test("another reader's session, a full account, a server error and a cut line each answer in the record's terms", async () => {
  const { syncReview } = await getDriver();
  answers = [Response.json({ error: "reader" }, { status: 409 })];
  assert.deepEqual(await syncReview(READER, 1000), { kind: "reader" });
  answers = [Response.json({ error: "quota" }, { status: 429 })];
  assert.deepEqual(await syncReview(READER, 1000), { kind: "failed", cause: "quota" });
  answers = [new Response("{}", { status: 500 })];
  assert.deepEqual(await syncReview(READER, 1000), { kind: "failed", cause: "server" });
  answers = [new TypeError("network")];
  assert.deepEqual(await syncReview(READER, 1000), { kind: "failed", cause: "offline" });
  assert.deepEqual(written, []);
});

test("a merge that fails leaves the cursors where they were", async () => {
  const { syncReview } = await getDriver();
  local = [entry("a", 100)];
  answers = [ok([entry("c", 300)], "cursor-1")];
  applyFails = true;
  const outcome = await syncReview(READER, 1000);
  assert.equal(outcome.kind, "failed");
  assert.deepEqual(written, []);
});

test("a browser with no IndexedDB sends nothing", async () => {
  const { syncReview } = await getDriver();
  const globals = globalThis as { indexedDB?: unknown };
  const held = globals.indexedDB;
  delete globals.indexedDB;
  try {
    assert.deepEqual(await syncReview(READER, 1000), { kind: "done", pulled: 0 });
    assert.equal(requests.length, 0);
  } finally {
    globals.indexedDB = held;
  }
});
