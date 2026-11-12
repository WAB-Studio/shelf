// RL-93: the review's half of a copy round, with the device's store replaced by a stand-in: what is under test
// is what a round asks of the account and when the review's cursors move.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

import { REVIEW_BATCH } from "./review-protocol";

const READER = "reader-1";
type Entry = { key: string; at: number; gone: boolean; card: null; sense: null };
const entry = (key: string, at: number, gone = false): Entry => ({ key, at, gone, card: null, sense: null });

let local: Entry[] = [];
let stored: { readerId: string | null; pushedThrough: number; cursor: string | null } = { readerId: null, pushedThrough: -1, cursor: null };
let written: (typeof stored)[] = [];
let applied: Entry[][] = [];
let applyFails = false;
let readFails = false;

type Driver = typeof import("./review-driver");
let driver: Driver | null = null;

async function getDriver(): Promise<Driver> {
  if (driver) return driver;
  Object.assign(globalThis, { indexedDB: {} });
  mock.module("../review/store", {
    namedExports: {
      readEntries: async () => {
        if (readFails) throw new Error("indexeddb");
        return local;
      },
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

const answer = (entries: Entry[], cursor: string | null = null, patch: { full?: boolean } = {}) => ({ accepted: 0, full: false, entries, cursor, ...patch });

beforeEach(() => {
  local = [];
  stored = { readerId: null, pushedThrough: -1, cursor: null };
  written = [];
  applied = [];
  applyFails = false;
  readFails = false;
});

test("a first round sends everything oldest first, and merges and remembers what comes down", async () => {
  const { readReviewTrip, landReviewAnswer } = await getDriver();
  local = [entry("b", 200), entry("a", 100)];
  const trip = await readReviewTrip(READER);
  assert.deepEqual(trip?.request.entries.map((sent) => sent.key), ["a", "b"]);
  assert.equal(trip?.request.since, null);

  const landed = await landReviewAnswer(trip!, answer([entry("c", 300)], "cursor-1"));
  assert.deepEqual(landed, { pulled: 1, more: false });
  assert.deepEqual(applied, [[entry("c", 300)]]);
  assert.deepEqual(written, [{ readerId: READER, pushedThrough: 200, cursor: "cursor-1" }]);
});

test("a later round sends only what is newer than the last one and echoes the cursor", async () => {
  const { readReviewTrip, landReviewAnswer } = await getDriver();
  stored = { readerId: READER, pushedThrough: 200, cursor: "cursor-1" };
  local = [entry("a", 100), entry("b", 200), entry("d", 400)];
  const trip = await readReviewTrip(READER);
  assert.deepEqual(trip?.request.entries.map((sent) => sent.key), ["d"]);
  assert.equal(trip?.request.since, "cursor-1");
  await landReviewAnswer(trip!, answer([], null));
  assert.deepEqual(written, [{ readerId: READER, pushedThrough: 400, cursor: "cursor-1" }]);
});

test("a review the copy last met for another reader starts over for this one", async () => {
  const { readReviewTrip } = await getDriver();
  stored = { readerId: "someone-else", pushedThrough: 900, cursor: "theirs" };
  local = [entry("a", 100)];
  const trip = await readReviewTrip(READER);
  assert.deepEqual(trip?.request.entries.map((sent) => sent.key), ["a"]);
  assert.equal(trip?.request.since, null);
});

test("a full page on either side asks for another round, and a short one does not", async () => {
  const { readReviewTrip, landReviewAnswer } = await getDriver();
  local = Array.from({ length: REVIEW_BATCH + 1 }, (_, i) => entry(`k${String(i).padStart(4, "0")}`, i + 1));
  const trip = await readReviewTrip(READER);
  assert.equal(trip?.request.entries.length, REVIEW_BATCH);
  assert.equal((await landReviewAnswer(trip!, answer([]))).more, true);
  const down = Array.from({ length: REVIEW_BATCH }, (_, i) => entry(`d${i}`, 5_000 + i));
  assert.equal((await landReviewAnswer(trip!, answer(down))).more, true);
  assert.equal((await landReviewAnswer(trip!, answer([entry("z", 9_000)]))).more, true);
  local = [entry("a", 1)];
  assert.equal((await landReviewAnswer((await readReviewTrip(READER))!, answer([entry("z", 9_000)]))).more, false);
});

test("an account at its bound kept nothing: what was sent stays to be sent, and the round does not repeat itself", async () => {
  const { readReviewTrip, landReviewAnswer } = await getDriver();
  local = Array.from({ length: REVIEW_BATCH }, (_, i) => entry(`k${String(i).padStart(4, "0")}`, i + 1));
  const trip = await readReviewTrip(READER);
  const landed = await landReviewAnswer(trip!, answer([], "cursor-1", { full: true }));
  assert.equal(landed.more, false);
  assert.deepEqual(written, [{ readerId: READER, pushedThrough: -1, cursor: "cursor-1" }]);
});

test("a server that answers no review leaves everything where it was", async () => {
  const { readReviewTrip, landReviewAnswer } = await getDriver();
  local = [entry("a", 100)];
  const trip = await readReviewTrip(READER);
  assert.deepEqual(await landReviewAnswer(trip!, null), { pulled: 0, more: false });
  assert.deepEqual(written, []);
});

test("a merge that fails leaves the cursors where they were", async () => {
  const { readReviewTrip, landReviewAnswer } = await getDriver();
  local = [entry("a", 100)];
  const trip = await readReviewTrip(READER);
  applyFails = true;
  await assert.rejects(landReviewAnswer(trip!, answer([entry("c", 300)], "cursor-1")));
  assert.deepEqual(written, []);
});

test("a store that does not answer, or a browser with no IndexedDB, asks nothing of the account", async () => {
  const { readReviewTrip } = await getDriver();
  readFails = true;
  assert.equal(await readReviewTrip(READER), null);
  readFails = false;
  const globals = globalThis as { indexedDB?: unknown };
  const held = globals.indexedDB;
  delete globals.indexedDB;
  try {
    assert.equal(await readReviewTrip(READER), null);
  } finally {
    globals.indexedDB = held;
  }
});
