// RNL-09 / module 696: the merge and the read keep the main thread free. A
// real IndexedDB request delivers its result in a task of its own, so this
// stand-in delivers every result through `setImmediate` and counts how much
// one task issues or reads. Writes are staged and commit only when the
// transaction completes, as in the real thing, and a transaction with
// nothing pending commits by itself — so work chained after that point fails.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { mock, test } from "node:test";

type Row = Record<string, unknown>;
type KeyRange = { lower: number; lowerOpen: boolean };
type Event = { preventDefault(): void };

type Req<T> = {
  onsuccess: (() => void) | null;
  onerror: ((event: Event) => void) | null;
  error: Error | null;
  result: T;
};

const committed = new Map<number, Row>();
let nextId = 1;
let failOnSeq: number | null = null;
const metrics = { adds: 0, maxAddsInTask: 0, maxRowsReadInTask: 0, transactions: 0 };

function reset(): void {
  committed.clear();
  nextId = 1;
  failOnSeq = null;
  metrics.adds = 0;
  metrics.maxAddsInTask = 0;
  metrics.maxRowsReadInTask = 0;
  metrics.transactions = 0;
}

function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function makeTransaction() {
  metrics.transactions += 1;
  const staged: Row[] = [];
  let pending = 0;
  let finished = false;
  const tx: {
    oncomplete: (() => void) | null;
    onabort: (() => void) | null;
    error: Error | null;
    objectStore(): unknown;
  } = { oncomplete: null, onabort: null, error: null, objectStore: () => store };

  function task(work: () => void): void {
    if (finished) throw named("TransactionInactiveError");
    pending += 1;
    setImmediate(() => {
      metrics.adds = 0;
      if (!finished) work();
      pending -= 1;
      setImmediate(() => {
        if (finished || pending > 0) return;
        finished = true;
        for (const row of staged) committed.set(row.id as number, row);
        tx.oncomplete?.();
      });
    });
  }
  function abort(error: Error): void {
    if (finished) return;
    finished = true;
    tx.error = error;
    staged.length = 0;
    setImmediate(() => tx.onabort?.());
  }
  const key = (row: Row) => `${row.device}:${row.deviceSeq}`;
  const taken = (row: Row) =>
    row.device != null &&
    [...committed.values(), ...staged].some((existing) => existing.device != null && key(existing) === key(row));
  const inRange = (range: KeyRange | undefined) =>
    [...committed.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, row]) => row)
      .filter((row) => !range || (range.lowerOpen ? (row.id as number) > range.lower : (row.id as number) >= range.lower));

  const store = {
    add(value: Row): Req<number | undefined> {
      const request: Req<number | undefined> = { onsuccess: null, onerror: null, error: null, result: undefined };
      if (finished) throw named("TransactionInactiveError");
      metrics.adds += 1;
      metrics.maxAddsInTask = Math.max(metrics.maxAddsInTask, metrics.adds);
      task(() => {
        const failure = value.deviceSeq === failOnSeq ? named("QuotaExceededError") : taken(value) ? named("ConstraintError") : null;
        if (failure) {
          request.error = failure;
          let prevented = false;
          request.onerror?.({ preventDefault: () => void (prevented = true) });
          if (!prevented) abort(failure);
          return;
        }
        const row = { ...value, id: nextId++ };
        staged.push(row);
        request.result = row.id;
        request.onsuccess?.();
      });
      return request;
    },
    getAll(range?: KeyRange, count?: number): Req<Row[]> {
      const request: Req<Row[]> = { onsuccess: null, onerror: null, error: null, result: [] };
      task(() => {
        const rows = inRange(range);
        request.result = typeof count === "number" ? rows.slice(0, count) : rows;
        metrics.maxRowsReadInTask = Math.max(metrics.maxRowsReadInTask, request.result.length);
        request.onsuccess?.();
      });
      return request;
    },
    openCursor(range?: KeyRange): Req<unknown> {
      const request: Req<unknown> = { onsuccess: null, onerror: null, error: null, result: null };
      const rows = inRange(range);
      const step = (index: number): void =>
        task(() => {
          metrics.maxRowsReadInTask = Math.max(metrics.maxRowsReadInTask, 1);
          request.result = index < rows.length ? { value: rows[index], continue: () => step(index + 1) } : null;
          request.onsuccess?.();
        });
      step(0);
      return request;
    },
  };
  return tx;
}

(globalThis as unknown as { IDBKeyRange: unknown }).IDBKeyRange = {
  lowerBound: (lower: number, open?: boolean) => ({ lower, lowerOpen: !!open }),
};

let merge: typeof import("./merge") | null = null;
async function getMerge(): Promise<typeof import("./merge")> {
  if (merge) return merge;
  mock.module("./record", {
    namedExports: { openLogDatabase: () => Promise.resolve({ transaction: () => makeTransaction() }) },
  });
  merge = await import("./merge");
  return merge;
}

function foreign(device: string, deviceSeq: number) {
  return {
    schema: 2,
    at: 1_700_000_000_000 + deviceSeq,
    text: `w-${deviceSeq}`,
    normalised: `w-${deviceSeq}`,
    kind: "word" as const,
    outcome: "exact" as const,
    headword: `w-${deviceSeq}`,
    rule: null,
    senses: 1,
    translation: null,
    dictionaryReady: true,
    origin: null,
    device,
    deviceSeq,
  };
}
const batch = (device: string, count: number, from = 0) => Array.from({ length: count }, (_, i) => foreign(device, from + i));

// ---- the chunk size (RNL-09) ----

test("RNL-09: no task issues more than 50 adds, and not a trickle of a few", async () => {
  const { mergeForeign } = await getMerge();
  reset();
  assert.equal(await mergeForeign(batch("dev-a", 1200)), 1200);
  assert.ok(metrics.maxAddsInTask <= 50, `${metrics.maxAddsInTask} adds in one task`);
  assert.ok(metrics.maxAddsInTask >= 25, `${metrics.maxAddsInTask} adds in the largest task: chunks too small to be quick`);
});

test("RNL-09: chunking stays inside the 500-row transaction — 1200 rows open three", async () => {
  const { mergeForeign } = await getMerge();
  reset();
  await mergeForeign(batch("dev-a", 1200));
  assert.equal(metrics.transactions, 3);
});

// ---- the same rows enter ----

test("RL-24: 10 000 rows enter, every one, none twice", async () => {
  const { mergeForeign } = await getMerge();
  reset();
  assert.equal(await mergeForeign(batch("dev-a", 10_000)), 10_000);
  assert.equal(committed.size, 10_000);
  assert.equal(new Set([...committed.values()].map((row) => row.deviceSeq)).size, 10_000);
});

test("RL-24: the same 500 merged twice enter 500 and then 0", async () => {
  const { mergeForeign } = await getMerge();
  reset();
  const rows = batch("dev-a", 500);
  assert.equal(await mergeForeign(rows), 500);
  assert.equal(await mergeForeign(rows), 0);
  assert.equal(committed.size, 500);
});

test("RL-24: a batch with 120 rows already merged, in the middle of a chunk, enters only the other 380", async () => {
  const { mergeForeign } = await getMerge();
  reset();
  await mergeForeign(batch("dev-a", 120, 30));
  assert.equal(await mergeForeign(batch("dev-a", 500)), 380);
  assert.equal(committed.size, 500);
});

// ---- a batch that lands half ----

test("a chunk that aborts rejects the promise, and its 500-row transaction leaves nothing behind", async () => {
  const { mergeForeign } = await getMerge();
  reset();
  failOnSeq = 260;
  await assert.rejects(mergeForeign(batch("dev-a", 500)), { name: "QuotaExceededError" });
  assert.equal(committed.size, 0);
});

test("a batch that lands stays landed; the one that aborts rejects and no further batch starts", async () => {
  const { mergeForeign } = await getMerge();
  reset();
  failOnSeq = 1100;
  await assert.rejects(mergeForeign(batch("dev-a", 2000)));
  assert.equal(committed.size, 1000);
  assert.deepEqual(
    [...committed.values()].map((row) => row.deviceSeq as number).sort((a, b) => a - b),
    Array.from({ length: 1000 }, (_, i) => i),
  );
  assert.equal(metrics.transactions, 3);
});

// ---- readSince: same answer, small reads ----

// 1..1200; a row is local when its id is a multiple of 7 or in 1195..1200.
const isOwn = (id: number) => id % 7 === 0 || id >= 1195;
function fillMixed(): void {
  reset();
  for (let id = 1; id <= 1200; id++) {
    committed.set(id, isOwn(id) ? { id, text: `own-${id}` } : { id, text: `f-${id}`, device: "other", deviceSeq: id });
  }
}

const table: { after: number; limit: number; scanned: number; through: number | null; ownCount: number; firstOwn: number | null; lastOwn: number | null }[] = [
  { after: 0, limit: 500, scanned: 500, through: 500, ownCount: 71, firstOwn: 7, lastOwn: 497 },
  { after: 500, limit: 500, scanned: 500, through: 1000, ownCount: 71, firstOwn: 504, lastOwn: 994 },
  { after: 1000, limit: 500, scanned: 200, through: 1200, ownCount: 34, firstOwn: 1001, lastOwn: 1200 },
  { after: 1200, limit: 500, scanned: 0, through: null, ownCount: 0, firstOwn: null, lastOwn: null },
  { after: 0, limit: 75, scanned: 75, through: 75, ownCount: 10, firstOwn: 7, lastOwn: 70 },
  { after: 1190, limit: 3, scanned: 3, through: 1193, ownCount: 0, firstOwn: null, lastOwn: null },
  { after: 3, limit: 51, scanned: 51, through: 54, ownCount: 7, firstOwn: 7, lastOwn: 49 },
];

for (const row of table) {
  test(`readSince(${row.after}, ${row.limit}) over 1 200 mixed rows: own, scannedThrough and scanned as the contract states`, async () => {
    const { readSince } = await getMerge();
    fillMixed();
    const page = await readSince(row.after, row.limit);
    assert.equal(page.scanned, row.scanned);
    assert.equal(page.scannedThrough, row.through);
    assert.equal(page.own.length, row.ownCount);
    assert.equal(page.own[0]?.id ?? null, row.firstOwn);
    assert.equal(page.own.at(-1)?.id ?? null, row.lastOwn);
    assert.ok(page.own.every((r) => r.device == null && isOwn(r.id as number)));
    assert.deepEqual(page.own.map((r) => r.id), [...page.own.map((r) => r.id as number)].sort((a, b) => a - b));
  });
}

test("RNL-09: readSince(0, 500) reads at most 50 rows in any one task", async () => {
  const { readSince } = await getMerge();
  fillMixed();
  await readSince(0, 500);
  assert.ok(metrics.maxRowsReadInTask <= 50, `${metrics.maxRowsReadInTask} rows read in one task`);
});
