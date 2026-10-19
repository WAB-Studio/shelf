// RL-55: a newer tab upgrading the schema waits on this tab's connection. The
// connection must close on `versionchange` and the next write must open a
// fresh one rather than reuse the dead handle. Node has no IndexedDB, so the
// real `record.ts` runs in a child process over a recording fake.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";

test("otra pestaña sube la versión: la conexión se cierra una vez y la siguiente escritura reabre", async () => {
  const script = `
    const calls = { open: 0, close: 0 };
    const stores = { lookups: [] };
    const connections = [];
    const makeStore = () => ({
      createIndex() {},
      add(row) { const stored = { ...row, id: stores.lookups.length + 1 }; stores.lookups.push(stored); return stored.id; },
      put(row) { stores.lookups.push(row); },
    });
    globalThis.indexedDB = {
      open(_name, wanted) {
        calls.open += 1;
        const request = {};
        queueMicrotask(() => {
          const database = {
            version: wanted,
            onversionchange: null,
            onclose: null,
            close() { calls.close += 1; },
            createObjectStore: () => makeStore(),
            objectStore: () => makeStore(),
            transaction: () => {
              const tx = { objectStore: () => makeStore(), oncomplete: null, onerror: null, onabort: null };
              queueMicrotask(() => tx.oncomplete?.());
              return tx;
            },
          };
          connections.push(database);
          request.result = database;
          request.transaction = database;
          request.onupgradeneeded?.({ oldVersion: 0 });
          request.onsuccess();
        });
        return request;
      },
    };
    const real = await import(${JSON.stringify(new URL("./record.ts", import.meta.url).href)});
    await real.openLogDatabase();
    const afterFirst = calls.open;
    connections[0].onversionchange({ newVersion: 4 });
    const closedAfterEvent = calls.close;
    await real.openLogDatabase();
    console.log(JSON.stringify({ afterFirst, closedAfterEvent, openAfterReopen: calls.open }));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: process.cwd() },
  );
  const seen = JSON.parse(stdout.trim().split("\n").pop()!) as {
    afterFirst: number;
    closedAfterEvent: number;
    openAfterReopen: number;
  };
  assert.equal(seen.afterFirst, 1);
  assert.equal(seen.closedAfterEvent, 1);
  assert.equal(seen.openAfterReopen, 2);
});

// RL-55 / RNL-06: which row the grabado machine commits. Module state
// (`pending`, the settle timer) lives for the life of a document, so each
// scenario runs in its own child process over a fake IndexedDB whose
// transactions never complete — the teardown a navigation causes. What was
// `add`ed, and what the localStorage relay still holds, is what the reader
// would find on the next document.
type Typed = { text: string; outcome?: string; kind?: "word" | "phrase"; at: number };
type Step = { type: Typed } | { wait: number } | { flush: true };
type Seen = {
  added: string[];
  relayed: string[];
  addedBeforeFlush: string[];
  rows: { normalised: string; kind: string; outcome: string; schema: number }[];
};

async function runScenario(steps: Step[]): Promise<Seen> {
  const script = `
    import { mock } from "node:test";
    mock.timers.enable({ apis: ["setTimeout"] });
    const added = [];
    const relay = new Map();
    globalThis.localStorage = {
      getItem: (key) => (relay.has(key) ? relay.get(key) : null),
      setItem: (key, value) => { relay.set(key, String(value)); },
      removeItem: (key) => { relay.delete(key); },
    };
    const makeStore = () => ({
      createIndex() {},
      add(row) { added.push(row); },
      index: () => ({ getAll: () => ({}) }),
    });
    globalThis.indexedDB = {
      open() {
        const request = {};
        queueMicrotask(() => {
          const database = {
            onversionchange: null,
            onclose: null,
            close() {},
            createObjectStore: () => makeStore(),
            objectStore: () => makeStore(),
            transaction: () => ({ objectStore: () => makeStore() }),
          };
          request.result = database;
          request.transaction = database;
          request.onupgradeneeded?.({ oldVersion: 0 });
          request.onsuccess();
        });
        return request;
      },
    };
    const real = await import(${JSON.stringify(new URL("./record.ts", import.meta.url).href)});
    await new Promise((resolve) => setImmediate(resolve));
    const rowFor = ({ text, outcome = "exact", kind = "word", at }) => ({
      at, text, normalised: text.toLowerCase(), kind, outcome,
      headword: text, rule: null, senses: 1, translation: null,
      dictionaryReady: true, origin: null,
    });
    let addedBeforeFlush = null;
    for (const step of ${JSON.stringify(steps)}) {
      if (step.type) real.recordLookup(rowFor(step.type));
      else if (step.wait !== undefined) mock.timers.tick(step.wait);
      else { addedBeforeFlush ??= added.map((r) => r.normalised); real.flushPendingLookup(); }
    }
    const raw = relay.get("voyager:pending-log-row");
    console.log(JSON.stringify({
      added: added.map((r) => r.normalised),
      relayed: raw ? JSON.parse(raw).map((r) => r.normalised) : [],
      addedBeforeFlush: addedBeforeFlush ?? added.map((r) => r.normalised),
      rows: added.map(({ normalised, kind, outcome, schema }) => ({ normalised, kind, outcome, schema })),
    }));
    process.exit(0);
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: process.cwd() },
  );
  return JSON.parse(stdout.trim().split("\n").pop()!) as Seen;
}

for (const waitMs of [0, 200, 400]) {
  test(`«book» asentado y «cat» sin vaciar la caja, vaciado a los ${waitMs} ms: dos filas y el relevo con las dos`, async () => {
    const seen = await runScenario([
      { type: { text: "book", at: 1000 } },
      { wait: 1200 },
      { type: { text: "cat", at: 2000 } },
      { wait: waitMs },
      { flush: true },
    ]);
    assert.deepEqual(seen.added.slice().sort(), ["book", "cat"]);
    assert.deepEqual(seen.relayed.slice().sort(), ["book", "cat"]);
  });
}

test("«boo» y luego «book» antes de asentar: una sola fila, «book»", async () => {
  const seen = await runScenario([
    { type: { text: "boo", at: 1000 } },
    { wait: 1000 },
    { type: { text: "book", at: 2000 } },
    { wait: 1000 },
    { flush: true },
  ]);
  assert.deepEqual(seen.added, ["book"]);
  assert.deepEqual(seen.relayed, ["book"]);
});

test("una pausa larga a media palabra, sin vaciar, no graba nada y deja una sola fila al vaciar", async () => {
  const seen = await runScenario([
    { type: { text: "boo", at: 1000 } },
    { wait: 60_000 },
    { type: { text: "book", at: 2000 } },
    { wait: 60_000 },
    { flush: true },
  ]);
  assert.deepEqual(seen.addedBeforeFlush, []);
  assert.deepEqual(seen.added, ["book"]);
});

test("un miss que no queda pendiente desplaza al prefijo asentado y no se graba, ni en el almacén ni en el relevo", async () => {
  const seen = await runScenario([
    { type: { text: "boo", at: 1000 } },
    { wait: 1000 },
    { type: { text: "zzz qqq", outcome: "miss", kind: "phrase", at: 2000 } },
    { wait: 1000 },
    { flush: true },
  ]);
  assert.deepEqual(seen.added, ["boo"]);
  assert.deepEqual(seen.relayed, ["boo"]);
});

// RL-76: only a lookup that would have been asked online waits as pending —
// a word with no entry, a sentence the translator would have taken. Every
// other miss still leaves no row.
test("pendiente: una palabra sin entrada se graba una vez, como «miss» de esquema 4 o más", async () => {
  const seen = await runScenario([
    { type: { text: "zorp", outcome: "miss", at: 1000 } },
    { wait: 1000 },
    { flush: true },
  ]);
  assert.equal(seen.rows.length, 1);
  assert.equal(seen.rows[0].normalised, "zorp");
  assert.equal(seen.rows[0].kind, "word");
  assert.equal(seen.rows[0].outcome, "miss");
  assert.ok(seen.rows[0].schema >= 4, `schema ${seen.rows[0].schema}`);
  assert.deepEqual(seen.relayed, ["zorp"]);
});

test("pendiente: una frase sin traducir se graba una vez, como «untranslated»", async () => {
  const seen = await runScenario([
    { type: { text: "The cat sat", outcome: "untranslated", kind: "phrase", at: 1000 } },
    { wait: 1000 },
    { flush: true },
  ]);
  assert.equal(seen.rows.length, 1);
  assert.equal(seen.rows[0].kind, "phrase");
  assert.equal(seen.rows[0].outcome, "untranslated");
  assert.ok(seen.rows[0].schema >= 4, `schema ${seen.rows[0].schema}`);
});

test("pendiente: una frase «miss» (larga o bajo el umbral) no deja fila", async () => {
  const seen = await runScenario([
    { type: { text: "a b", outcome: "miss", kind: "phrase", at: 1000 } },
    { wait: 1000 },
    { flush: true },
  ]);
  assert.deepEqual(seen.added, []);
  assert.deepEqual(seen.relayed, []);
});

test("pendiente: una palabra «untranslated» no es una forma pendiente y no deja fila", async () => {
  const seen = await runScenario([
    { type: { text: "zorp", outcome: "untranslated", kind: "word", at: 1000 } },
    { wait: 1000 },
    { flush: true },
  ]);
  assert.deepEqual(seen.added, []);
});

test("pendiente: una palabra sin entrada desplaza al prefijo asentado y las dos se graban", async () => {
  const seen = await runScenario([
    { type: { text: "boo", at: 1000 } },
    { wait: 1000 },
    { type: { text: "zzz", outcome: "miss", at: 2000 } },
    { wait: 1000 },
    { flush: true },
  ]);
  assert.deepEqual(seen.added.slice().sort(), ["boo", "zzz"]);
});
