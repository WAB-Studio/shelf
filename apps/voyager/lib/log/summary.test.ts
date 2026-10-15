// RL-56's contract on `lookups`: the reader's record groups by word, one row
// per word, ordered by frequency; tapping a word opens every one of its
// searches with its date. Node has no IndexedDB, so `./record`'s
// `openLogDatabase` is mocked with a hand-rolled cursor that iterates a
// plain array in index-key order — nothing about `record.ts` itself is
// under test here, the same boundary `merge.test.ts` draws.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mock, test } from "node:test";
import { promisify } from "node:util";

import type { LookupRecord } from "./types";

type Row = LookupRecord & { id: number };

type FakeRequest<T> = {
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  error: Error | null;
  result: T;
};

type FakeCursor = { value: Row; continue(): void };

// `IDBKeyRange.only` is the one range `readLemmaHistory` builds; `merge.test.ts`
// mocks `.lowerBound` the same way, for the one range its own module builds.
(globalThis as unknown as { IDBKeyRange: { only(value: string): { only: string } } }).IDBKeyRange = {
  only: (value) => ({ only: value }),
};

function makeCursorRequest(rows: Row[]): FakeRequest<FakeCursor | null> {
  const request: FakeRequest<FakeCursor | null> = { onsuccess: null, onerror: null, error: null, result: null };
  let i = 0;
  function step(): void {
    queueMicrotask(() => {
      request.result =
        i < rows.length
          ? {
              value: rows[i],
              continue: () => {
                i += 1;
                step();
              },
            }
          : null;
      request.onsuccess?.();
    });
  }
  step();
  return request;
}

// Every `openCursor` the code under test makes, with the index it asked
// of and the range it bounded to (`undefined` for a pass over the lot).
let cursorCalls: { index: string; range: { only: string } | undefined }[] = [];

function fakeDatabase(rows: Row[]) {
  return {
    transaction: () => ({
      objectStore: () => ({
        index: (name: string) => ({
          openCursor: (range?: { only: string }) => {
            cursorCalls.push({ index: name, range });
            const key = (r: Row): string => (name === "headword" ? (r.headword ?? "") : r.normalised);
            const sorted = [...rows]
              .filter((r) => name !== "headword" || r.headword !== null)
              .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id - b.id));
            const filtered = range ? sorted.filter((r) => key(r) === range.only) : sorted;
            return makeCursorRequest(filtered);
          },
        }),
      }),
    }),
  };
}

let currentRows: Row[] = [];

// Mocked and imported lazily, the same reason `merge.test.ts` does it: this
// file has no top-level await, and the mock must land before `summary.ts` —
// via `record.ts` — is ever imported.
let summary: typeof import("./summary") | null = null;
async function getSummary(): Promise<typeof import("./summary")> {
  if (summary) return summary;
  mock.module("./record", {
    namedExports: { openLogDatabase: () => Promise.resolve(fakeDatabase(currentRows)) },
  });
  summary = await import("./summary");
  return summary;
}

function row(
  id: number,
  normalised: string,
  overrides: Partial<Row> = {},
): Row {
  return {
    id,
    schema: 2,
    at: 1_700_000_000_000 + id,
    text: normalised,
    normalised,
    kind: "word",
    outcome: "exact",
    headword: normalised,
    rule: null,
    senses: 1,
    translation: `t-${id}`,
    dictionaryReady: true,
    origin: null,
    ...overrides,
  };
}

// --- readWordStudy: grouping, ordering, limit vs. total ---

test("readWordStudy: one row per distinct normalised word, counting every search", async () => {
  currentRows = [row(1, "cat"), row(2, "cat"), row(3, "dog")];
  const { readWordStudy } = await getSummary();
  const { rows, total } = await readWordStudy();
  assert.equal(total, 2);
  const byWord = new Map(rows.map((r) => [r.normalised, r]));
  assert.equal(byWord.get("cat")?.count, 2);
  assert.equal(byWord.get("dog")?.count, 1);
});

test("readWordStudy: rows sort by frequency — the most-searched word leads", async () => {
  currentRows = [row(1, "dog"), row(2, "cat"), row(3, "cat"), row(4, "cat")];
  const { readWordStudy } = await getSummary();
  const { rows } = await readWordStudy();
  assert.equal(rows[0].normalised, "cat");
  assert.equal(rows[0].count, 3);
  assert.equal(rows[1].normalised, "dog");
});

test("readWordStudy: a tie in frequency breaks toward the most recently searched", async () => {
  currentRows = [row(1, "old", { at: 1000 }), row(2, "new", { at: 2000 })];
  const { readWordStudy } = await getSummary();
  const { rows } = await readWordStudy();
  assert.equal(rows[0].normalised, "new");
  assert.equal(rows[1].normalised, "old");
});

test("readWordStudy: display, translation and outcome come from the group's most recent row, not its first", async () => {
  currentRows = [
    row(1, "cat", { at: 1000, text: "CAT", translation: "gato viejo", outcome: "exact" }),
    row(2, "cat", { at: 2000, text: "cat", translation: "gato nuevo", outcome: "inflected" }),
  ];
  const { readWordStudy } = await getSummary();
  const { rows } = await readWordStudy();
  assert.equal(rows[0].display, "cat");
  assert.equal(rows[0].lastTranslation, "gato nuevo");
  assert.equal(rows[0].lastOutcome, "inflected");
  assert.equal(rows[0].lastAt, 2000);
});

test("readWordStudy: two searches settled the same millisecond keep the earlier one's display, translation and outcome", async () => {
  currentRows = [
    row(1, "cat", { at: 5000, text: "first", translation: "t1", outcome: "exact" }),
    row(2, "cat", { at: 5000, text: "second", translation: "t2", outcome: "inflected" }),
  ];
  const { readWordStudy } = await getSummary();
  const { rows } = await readWordStudy();
  assert.equal(rows[0].display, "first");
  assert.equal(rows[0].lastTranslation, "t1");
  assert.equal(rows[0].lastOutcome, "exact");
  assert.equal(rows[0].count, 2);
});

test("readWordStudy: limit caps the visible rows but total still counts every group", async () => {
  currentRows = [row(1, "a"), row(2, "b"), row(3, "c")];
  const { readWordStudy } = await getSummary();
  const { rows, total } = await readWordStudy(1);
  assert.equal(rows.length, 1);
  assert.equal(total, 3);
});

test("readWordStudy: a schema-1 row with no translation field reads as null, not undefined", async () => {
  const bare = row(1, "cat");
  delete (bare as Partial<Row>).translation;
  currentRows = [bare];
  const { readWordStudy } = await getSummary();
  const { rows } = await readWordStudy();
  assert.equal(rows[0].lastTranslation, null);
});

// --- the network's answer on the row (RL-62) ---

test("historia de lema: a schema-2 row reads with definition and both examples as null", async () => {
  currentRows = [row(1, "linger")];
  const { readLemmaHistory } = await getSummary();
  const { rows } = await readLemmaHistory("linger");
  assert.equal(rows[0].definition, null);
  assert.equal(rows[0].exampleEn, null);
  assert.equal(rows[0].exampleEs, null);
});

test("historia de lema: an unlisted row returns its definition and both examples", async () => {
  currentRows = [
    row(1, "blorpt", {
      schema: 3,
      headword: null,
      outcome: "unlisted" as Row["outcome"],
      definition: "a made-up word",
      exampleEn: "He said blorpt.",
      exampleEs: "Dijo blorpt.",
    }),
  ];
  const { readLemmaHistory } = await getSummary();
  const { rows } = await readLemmaHistory("blorpt");
  assert.equal(rows[0].definition, "a made-up word");
  assert.equal(rows[0].exampleEn, "He said blorpt.");
  assert.equal(rows[0].exampleEs, "Dijo blorpt.");
});

// --- properties: the grouping is order-independent, and the parts sum to the total ---

test("property: readWordStudy's grouping does not depend on the order the rows were stored in", async () => {
  const { readWordStudy } = await getSummary();
  let seed = 20260919;
  function rand(): number {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  }
  const words = ["alfa", "bravo", "charlie", "delta", "echo"];
  for (let trial = 0; trial < 30; trial++) {
    const n = 3 + Math.floor(rand() * 30);
    const rows: Row[] = [];
    for (let i = 0; i < n; i++) {
      const word = words[Math.floor(rand() * words.length)];
      rows.push(row(i + 1, word, { at: 1_700_000_000_000 + i }));
    }
    currentRows = rows;
    const inOrder = await readWordStudy();
    currentRows = [...rows].reverse();
    const reversed = await readWordStudy();
    assert.deepEqual(reversed.rows, inOrder.rows, `trial=${trial}`);
    assert.equal(reversed.total, inOrder.total);
  }
});

test("property: the sum of every group's count equals the number of rows recorded", async () => {
  const { readWordStudy } = await getSummary();
  let seed = 424242;
  function rand(): number {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  }
  const words = ["one", "two", "three", "four"];
  for (let trial = 0; trial < 30; trial++) {
    const n = 1 + Math.floor(rand() * 40);
    const rows: Row[] = [];
    for (let i = 0; i < n; i++) {
      const word = words[Math.floor(rand() * words.length)];
      rows.push(row(i + 1, word, { at: 1_700_000_000_000 + i }));
    }
    currentRows = rows;
    const { rows: studyRows } = await readWordStudy();
    const sum = studyRows.reduce((total, r) => total + r.count, 0);
    assert.equal(sum, n, `trial=${trial}`);
  }
});

// --- module 561: grouped by lemma, bounded by two cursors ---

test("por lema: an exact row and an inflected one share one group with both forms", async () => {
  currentRows = [
    row(1, "linger", { headword: "linger", outcome: "exact" }),
    row(2, "lingered", { headword: "linger", outcome: "inflected" }),
  ];
  const { readWordStudy } = await getSummary();
  const { rows, total } = await readWordStudy();
  assert.equal(total, 1);
  assert.equal(rows[0].key, "linger");
  assert.equal(rows[0].count, 2);
  assert.deepEqual(
    [...rows[0].forms].sort((a, b) => a.text.localeCompare(b.text)),
    [
      { text: "linger", count: 1 },
      { text: "lingered", count: 1 },
    ],
  );
});

test("sin lema: a phrase and an unlisted word each group by their own text", async () => {
  currentRows = [
    row(1, "a piece of cake", { headword: null, kind: "phrase", outcome: "phrase" as Row["outcome"] }),
    row(2, "blorpt", { headword: null, outcome: "unlisted" as Row["outcome"] }),
  ];
  const { readWordStudy } = await getSummary();
  const { rows, total } = await readWordStudy();
  assert.equal(total, 2);
  assert.deepEqual(rows.map((r) => r.key).sort(), ["a piece of cake", "blorpt"]);
});

test("una pasada: readWordStudy opens exactly one cursor", async () => {
  currentRows = [row(1, "cat"), row(2, "dog")];
  const { readWordStudy } = await getSummary();
  cursorCalls = [];
  await readWordStudy();
  assert.equal(cursorCalls.length, 1);
});

test("historia de lema: both forms come back once, a row matching both indexes is not doubled", async () => {
  currentRows = [
    row(1, "linger", { headword: "linger", at: 1000 }),
    row(2, "lingered", { headword: "linger", outcome: "inflected", at: 2000 }),
    row(3, "other", { headword: "other" }),
  ];
  const { readLemmaHistory } = await getSummary();
  const { rows, total } = await readLemmaHistory("linger");
  assert.equal(total, 2);
  assert.deepEqual(rows.map((r) => r.text), ["lingered", "linger"]);
});

test("acotada: readLemmaHistory opens only cursors ranged to the key, two of them", async () => {
  currentRows = [row(1, "linger"), row(2, "lingered", { headword: "linger" }), row(3, "dog")];
  const { readLemmaHistory } = await getSummary();
  cursorCalls = [];
  await readLemmaHistory("linger");
  assert.equal(cursorCalls.length, 2);
  assert.deepEqual(cursorCalls.map((c) => c.index).sort(), ["headword", "normalised"]);
  assert.ok(cursorCalls.every((c) => c.range?.only === "linger"));
});

test("lema de una forma: the headword of the form's most recent row, the form itself when none", async () => {
  currentRows = [
    row(1, "lingered", { headword: "linger", at: 1000 }),
    row(2, "lingered", { headword: "lingerer", at: 2000 }),
    row(3, "blorpt", { headword: null, outcome: "unlisted" as Row["outcome"] }),
  ];
  const { readLemmaKey } = await getSummary();
  assert.equal(await readLemmaKey("lingered"), "lingerer");
  assert.equal(await readLemmaKey("blorpt"), "blorpt");
  assert.equal(await readLemmaKey("never"), "never");
});

test("lema de una forma: two rows of the form at the same instant, the higher id's headword wins", async () => {
  currentRows = [
    row(4, "lingered", { headword: "linger", at: 5000 }),
    row(9, "lingered", { headword: "lingerer", at: 5000 }),
  ];
  const { readLemmaKey } = await getSummary();
  assert.equal(await readLemmaKey("lingered"), "lingerer");
});

test("historia del lema: searches at the same millisecond come newest id first", async () => {
  currentRows = [
    row(1, "linger", { at: 7000, text: "first" }),
    row(2, "lingered", { at: 7000, text: "second", headword: "linger" }),
    row(3, "linger", { at: 7000, text: "third" }),
  ];
  const { readLemmaHistory } = await getSummary();
  const { rows } = await readLemmaHistory("linger");
  assert.deepEqual(rows.map((r) => r.text), ["third", "second", "first"]);
});

test("acotada: readLemmaKey opens one cursor, ranged to the form", async () => {
  currentRows = [row(1, "linger"), row(2, "lingered", { headword: "linger" }), row(3, "dog")];
  const { readLemmaKey } = await getSummary();
  cursorCalls = [];
  await readLemmaKey("lingered");
  assert.equal(cursorCalls.length, 1);
  assert.equal(cursorCalls[0].index, "normalised");
  assert.equal(cursorCalls[0].range?.only, "lingered");
});

test("subida de versión: a v2 base opens at v3 with the same rows and the headword index", async () => {
  // The real `record.ts` runs in a child process: the `./record` mock above
  // cannot be lifted inside this one.
  const script = `
    const stores = new Map([
      ["lookups", { indexes: new Set(["at", "normalised", "foreign"]), rows: [{ id: 1, normalised: "cat" }, { id: 2, normalised: "dog" }, { id: 3, normalised: "eel" }] }],
      ["sync", { indexes: new Set(), rows: [] }],
    ]);
    let version = 2;
    globalThis.indexedDB = {
      open(_name, wanted) {
        const request = {};
        queueMicrotask(() => {
          const database = {
            get version() { return version; },
            createObjectStore: (name) => stores.set(name, { indexes: new Set(), rows: [] }),
            objectStore: (name) => {
              const store = stores.get(name);
              return {
                createIndex: (index) => store.indexes.add(index),
                put: (row) => {
                  const at = store.rows.findIndex((r) => r.id === row.id);
                  if (at >= 0) store.rows[at] = row; else store.rows.push(row);
                },
                delete: (id) => { store.rows = store.rows.filter((r) => r.id !== id); },
                clear: () => { store.rows = []; },
                openCursor: () => { throw new Error("not needed"); },
              };
            },
          };
          request.result = database;
          request.transaction = database;
          if (wanted > version) {
            const oldVersion = version;
            version = wanted;
            request.onupgradeneeded({ oldVersion });
          }
          request.onsuccess();
        });
        return request;
      },
    };
    const real = await import(${JSON.stringify(new URL("./record.ts", import.meta.url).href)});
    const database = await real.openLogDatabase();
    console.log(JSON.stringify({
      constant: real.DATABASE_VERSION,
      version: database.version,
      rows: stores.get("lookups").rows,
      indexes: [...stores.get("lookups").indexes],
    }));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: process.cwd() },
  );
  const seen = JSON.parse(stdout.trim().split("\n").pop()!) as {
    constant: number;
    version: number;
    rows: unknown[];
    indexes: string[];
  };
  assert.equal(seen.constant, 3);
  assert.equal(seen.version, 3);
  assert.deepEqual(seen.rows, [
    { id: 1, normalised: "cat" },
    { id: 2, normalised: "dog" },
    { id: 3, normalised: "eel" },
  ]);
  assert.ok(seen.indexes.includes("headword"));
  assert.ok(seen.indexes.includes("normalised"));
});
