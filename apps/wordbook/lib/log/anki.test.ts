// RL-72, RL-92: the Anki CSV holds one quoted card per study group, the same card the app draws.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Sense } from "@/lib/dictionary/index-build";
import type { WordAnswer } from "@/lib/dictionary/lookup";
import { senseChoiceFor } from "@/lib/review/sense";

import { buildAnkiCsv as build, buildAnkiExport, cardBack, cardFront, readAnkiCounts, type CardExtras, type CardLabels } from "./anki";
import type { StudyRow } from "./summary";

const labels: CardLabels = { pos: (pos) => ({ n: "sustantivo", v: "verbo", adj: "adjetivo", adv: "adverbio", pn: "nombre propio", phraseologicalUnit: "locución" })[pos] };

function buildAnkiCsv(rows: StudyRow[], extras?: Map<string, CardExtras>) {
  return build(rows, labels, extras);
}

function row(key: string, over: Partial<StudyRow> = {}): StudyRow {
  return {
    key,
    normalised: key,
    forms: [{ text: key, count: 1 }],
    display: key,
    count: 1,
    lastAt: 1,
    lastTranslation: `t-${key}`,
    lastDefinition: null,
    lastOutcome: "inflected",
    ...over,
  };
}

// A minimal RFC 4180 reader: quoted fields, doubled quotes, newlines inside.
function parse(csv: string): string[][] {
  const records: string[][] = [];
  let current: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (quoted) {
      if (char === '"' && csv[i + 1] === '"') {
        value += '"';
        i++;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      current.push(value);
      value = "";
    } else if (char === "\n") {
      current.push(value);
      records.push(current);
      current = [];
      value = "";
    } else value += char;
  }
  return records;
}

test("the first two lines are the Anki directives", () => {
  // Mutation: drop `#html:true`, which the `<br>` of a card needs.
  const lines = buildAnkiCsv([row("a")]).csv.split("\n");
  assert.deepEqual(lines.slice(0, 2), ["#separator:Comma", "#html:true"]);
});

test("one card per translated group, in the order given", () => {
  // Mutation: reverse or sort the rows.
  const { csv, cards } = buildAnkiCsv([row("zebra"), row("apple"), row("mango")]);
  assert.equal(cards, 3);
  assert.deepEqual(csv.split("\n").slice(2, 5), ['"zebra","t-zebra"', '"apple","t-apple"', '"mango","t-mango"']);
});

test("an inflected group fronts its lemma, not the form searched", () => {
  // Mutation: always `display`.
  assert.equal(cardFront(row("leave", { display: "left", lastOutcome: "inflected" })), "leave");
});

test("a translated or unlisted group fronts the text as typed", () => {
  // Mutation: always `key`.
  assert.equal(cardFront(row("k", { display: "Look Up", lastOutcome: "translated" })), "Look Up");
  assert.equal(cardFront(row("k", { display: "Zzyzx", lastOutcome: "unlisted" })), "Zzyzx");
});

test("the back is the logged translation verbatim", () => {
  // Mutation: use `forms`.
  const { csv } = buildAnkiCsv([
    row("row", { forms: [{ text: "rows", count: 2 }], lastTranslation: "remo, fila, remar" }),
  ]);
  assert.equal(csv.split("\n")[2], '"row","remo, fila, remar"');
});

test("a group with no translation is left out", () => {
  // Mutation: emit an empty back.
  const { csv, cards, skipped } = buildAnkiCsv([row("a"), row("b", { lastTranslation: null }), row("c")]);
  assert.equal(cards, 2);
  assert.equal(skipped, 1);
  assert.equal(parse(csv).length, 4);
  assert.ok(!csv.includes('"b"'));
});

test("commas and quotes round-trip through a CSV parser; a newline is a <br>, never a line break of the file", () => {
  // Mutation: skip doubling `"`, or leave the newline raw.
  const { csv } = buildAnkiCsv([row('say "hi", ok', { lastTranslation: 'a, b "quoted"\nsecond line' })]);
  assert.deepEqual(parse(csv).slice(2), [['say "hi", ok', 'a, b "quoted"<br>second line']]);
  assert.equal(csv.split("\n").length, 4);
});

test("an empty study is the header alone", () => {
  const { csv, cards, skipped } = buildAnkiCsv([]);
  assert.equal(cards, 0);
  assert.equal(skipped, 0);
  assert.equal(csv, "#separator:Comma\n#html:true\n");
});

test("a network word with only a definition gets a card", () => {
  // Mutation: drop the definition fallback.
  const { csv, cards, skipped } = buildAnkiCsv([
    row("boat", { lastOutcome: "unlisted", lastTranslation: null, lastDefinition: "a small boat" }),
  ]);
  assert.equal(cards, 1);
  assert.equal(skipped, 0);
  assert.equal(csv.split("\n")[2], '"boat","a small boat"');
});

test("a translation still wins over the definition", () => {
  // Mutation: definition first.
  const both = row("a", { lastTranslation: "uno", lastDefinition: "one" });
  assert.equal(cardBack(both), "uno");
  assert.equal(buildAnkiCsv([both]).csv.split("\n")[2], '"a","uno"');
});

test("a group with neither is skipped and counted", () => {
  // Mutation: count it as a card.
  const { csv, cards, skipped } = buildAnkiCsv([row("a", { lastTranslation: null, lastDefinition: null })]);
  assert.equal(cards, 0);
  assert.equal(skipped, 1);
  assert.equal(csv, "#separator:Comma\n#html:true\n");
});

test("a definition with commas, quotes and newlines round-trips, whole and escaped", () => {
  // Mutation: skip doubling `"`, split the prose on its commas, or leave `<` raw.
  const { csv } = buildAnkiCsv([row("w", { lastTranslation: null, lastDefinition: 'a, b "quoted" <i> & more\nsecond line' })]);
  assert.deepEqual(parse(csv).slice(2), [["w", 'a, b "quoted" &lt;i&gt; &amp; more<br>second line']]);
});

// --- RL-92: the back is the card the app draws ---

const treeVerb: Sense = { pos: "v", ipa: null, translations: ["enarbolar"], definition: "(transitive) To place upon a shoe tree." };
const treeNoun: Sense = { pos: "n", ipa: null, translations: ["árbol", "fuste", "madero", "palo"], definition: "A tall plant." };
const treeSenses = [treeVerb, treeNoun];
const treeAnswer: WordAnswer = {
  query: "tree",
  exact: { headword: "tree", senses: treeSenses, ranked: false },
  viaInflection: [],
  correction: [],
};

test("RL-92: a word's back is its sense: part of speech, up to three translations and the definition", () => {
  // Mutation: the whole line, a fourth translation, no part of speech, or no definition.
  const tree = row("tree", { lastTranslation: "enarbolar, árbol, fuste, madero, palo" });
  const withSense = buildAnkiCsv([tree], new Map([["tree", { sense: treeNoun, sentence: null }]]));
  assert.deepEqual(parse(withSense.csv).slice(2), [["tree", "sustantivo<br>árbol, fuste, madero<br>A tall plant."]]);
  const verb = buildAnkiCsv([tree], new Map([["tree", { sense: treeVerb, sentence: null }]]));
  assert.deepEqual(parse(verb.csv).slice(2), [["tree", "verbo<br>enarbolar<br>(transitive) To place upon a shoe tree."]]);
});

test("RL-92: a sense with no definition draws no empty line", () => {
  const bare: Sense = { pos: "n", ipa: null, translations: ["libro"], definition: null };
  const { csv } = buildAnkiCsv([row("book")], new Map([["book", { sense: bare, sentence: null }]]));
  assert.deepEqual(parse(csv).slice(2), [["book", "sustantivo<br>libro"]]);
});

test("RL-92: a word with no sense keeps three translations of its logged line, not all fifteen", () => {
  // Mutation: the line verbatim.
  const line = Array.from({ length: 15 }, (_, i) => `t${i}`).join(", ");
  const { csv } = buildAnkiCsv([row("row", { lastTranslation: line })]);
  assert.deepEqual(parse(csv).slice(2), [["row", "t0, t1, t2"]]);
});

test("RL-92: a phrase's back is its translation, whole, with no sentence of its own", () => {
  // Mutation: split a phrase's translation on its commas.
  const phrase = row("give it up", { lastOutcome: "translated", lastTranslation: "ríndete, deja de intentarlo" });
  const { csv } = buildAnkiCsv([phrase]);
  assert.deepEqual(parse(csv).slice(2), [["give it up", "ríndete, deja de intentarlo"]]);
});

test("RL-92: the reader's own sentence goes under the card with the word set apart", () => {
  // Mutation: drop the sentence, or leave the word unmarked.
  const extras = new Map([["tree", { sense: treeNoun, sentence: { text: "I climbed the tree <fast>", forms: ["tree"] } }]]);
  const { csv } = buildAnkiCsv([row("tree")], extras);
  assert.deepEqual(parse(csv).slice(2), [["tree", "sustantivo<br>árbol, fuste, madero<br>A tall plant.<br><br>I climbed the <b>tree</b> &lt;fast&gt;"]]);
});

// --- RL-76 / RL-72: a pending row is left out of the file and counted apart ---
//
// `record.ts` opens IndexedDB on first use, not at import, so a stand-in set
// here before the first read is the one `readAnkiCounts` reaches. It serves
// `lookups` read-only: every row in key order, a cursor over any index in
// that index's order.

type StoredRow = Record<string, unknown> & { id: number };
let storedRows: StoredRow[] = [];

function cursorOver(rows: StoredRow[], keyOf: (row: StoredRow) => unknown) {
  const sorted = rows
    .filter((r) => keyOf(r) !== null && keyOf(r) !== undefined)
    .sort((a, b) => {
      const ka = String(keyOf(a));
      const kb = String(keyOf(b));
      return ka < kb ? -1 : ka > kb ? 1 : a.id - b.id;
    });
  const request: { result: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
    result: null,
    onsuccess: null,
    onerror: null,
  };
  let i = 0;
  const step = () =>
    setImmediate(() => {
      request.result =
        i < sorted.length ? { value: structuredClone(sorted[i]), key: keyOf(sorted[i]), primaryKey: sorted[i].id, continue: () => (i++, step()) } : null;
      request.onsuccess?.();
    });
  step();
  return request;
}

function done<T>(result: T) {
  const request: { result: T; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
    result,
    onsuccess: null,
    onerror: null,
  };
  setImmediate(() => request.onsuccess?.());
  return request;
}

// The senses the reader tapped, as `reading-review` keeps them: read by key.
let tappedSenses = new Map<string, unknown>();

function readOnlyStore() {
  return {
    get: (key: string) => done(tappedSenses.get(key)),
    getAll: () => done(storedRows.map((r) => structuredClone(r))),
    count: () => done(storedRows.length),
    openCursor: () => cursorOver(storedRows, (r) => r.id),
    index: (name: string) => ({
      openCursor: () => cursorOver(storedRows, (r) => r[name]),
      getAll: () => done(storedRows.filter((r) => r[name] != null).map((r) => structuredClone(r))),
    }),
    createIndex() {},
  };
}

function readOnlyTransaction() {
  const transaction = {
    objectStore: () => readOnlyStore(),
    oncomplete: null as (() => void) | null,
    onerror: null,
    onabort: null,
  };
  setTimeout(() => transaction.oncomplete?.(), 5);
  return transaction;
}

(globalThis as unknown as { indexedDB: unknown }).indexedDB = {
  open() {
    const database = {
      close() {},
      onclose: null,
      onversionchange: null,
      objectStoreNames: { contains: () => true },
      createObjectStore: () => readOnlyStore(),
      transaction: () => readOnlyTransaction(),
    };
    const request: Record<string, unknown> & { onsuccess?: () => void; onupgradeneeded?: (e: unknown) => void } = {
      result: database,
      transaction: { objectStore: () => readOnlyStore() },
    };
    setImmediate(() => {
      request.onupgradeneeded?.({ oldVersion: 0 });
      request.onsuccess?.();
    });
    return request;
  },
};

function lookup(id: number, normalised: string, overrides: Record<string, unknown> = {}): StoredRow {
  return {
    id,
    schema: 4,
    at: 1_700_000_000_000 + id,
    text: normalised,
    normalised,
    kind: "word",
    outcome: "exact",
    headword: normalised,
    rule: null,
    senses: 1,
    translation: `t-${normalised}`,
    dictionaryReady: true,
    origin: null,
    ...overrides,
  };
}

const waitingWord = { outcome: "miss", headword: null, senses: 0, translation: null };

test("Anki: una palabra pendiente cuenta en pending, no en skipped, y no da tarjeta", async () => {
  // Mutation: count it as skipped.
  storedRows = [
    lookup(1, "cat"),
    lookup(2, "dog", { translation: null }),
    lookup(3, "zorp", waitingWord),
  ];
  const counts = await readAnkiCounts();
  assert.equal(counts.cards, 1);
  assert.equal(counts.skipped, 1, "the pending row is not counted as left out");
  assert.equal(counts.pending, 1);
  const { csv } = await buildAnkiExport(labels);
  assert.ok(!csv.includes("zorp"), csv);
});

test("Anki: una frase pendiente cuenta en pending", async () => {
  storedRows = [lookup(1, "the cat sat", { ...waitingWord, kind: "phrase", outcome: "untranslated" })];
  const counts = await readAnkiCounts();
  assert.equal(counts.pending, 1);
  assert.equal(counts.skipped, 0);
  assert.equal(counts.cards, 0);
});

test("Anki: un «miss» de esquema 3 no es pendiente, queda fuera como siempre", async () => {
  storedRows = [lookup(1, "zorp", { ...waitingWord, schema: 3 })];
  const counts = await readAnkiCounts();
  assert.equal(counts.pending, 0);
  assert.equal(counts.skipped, 1);
});

test("Anki: respondida, la palabra entra con su respuesta", async () => {
  storedRows = [
    lookup(1, "zorp", { ...waitingWord, at: 1000 }),
    lookup(2, "zorp", { outcome: "unlisted", headword: null, senses: 0, translation: "zorpo", at: 2000 }),
  ];
  const counts = await readAnkiCounts();
  assert.equal(counts.pending, 0);
  assert.equal(counts.cards, 1);
  assert.ok((await buildAnkiExport(labels)).csv.includes('"zorp","zorpo"'));
});

// --- RL-92: the file built from the record, the dictionary's answers and the reader's taps ---

const answersOf = async () => new Map([["tree", treeAnswer]]);

function treeRecord(): StoredRow[] {
  return [
    lookup(1, "tree", { headword: "tree", translation: "enarbolar, árbol, fuste" }),
    lookup(2, "i climbed the tree", {
      kind: "phrase",
      outcome: "translated",
      headword: null,
      senses: 0,
      translation: "subí al árbol",
      origin: "network",
    }),
  ];
}

test("RL-92: with no tap the file draws the default sense, with the reader's sentence; the phrase keeps its translation", async () => {
  // Mutation: the first sense of the group, or the sentence left out.
  storedRows = treeRecord();
  tappedSenses = new Map();
  const { csv, cards, plain } = await buildAnkiExport(labels, answersOf);
  assert.equal(cards, 2);
  assert.equal(plain, false);
  const lines = parse(csv).slice(2);
  assert.deepEqual(
    lines.find(([front]) => front === "tree"),
    ["tree", "sustantivo<br>árbol, fuste<br><br>i climbed the <b>tree</b>"],
  );
  assert.deepEqual(
    lines.find(([front]) => front !== "tree"),
    ["i climbed the tree", "subí al árbol"],
  );
});

test("RL-92: the sense the reader tapped is the one on the card", async () => {
  // Mutation: ignore the tap.
  storedRows = treeRecord();
  tappedSenses = new Map([["tree", senseChoiceFor("tree", treeSenses, treeVerb)]]);
  const { csv } = await buildAnkiExport(labels, answersOf);
  const card = parse(csv).slice(2).find(([front]) => front === "tree");
  assert.equal(card?.[1], "verbo<br>enarbolar<br>(transitive) To place upon a shoe tree.<br><br>i climbed the <b>tree</b>");
});

test("RL-92: with no dictionary on the device the words keep the logged line, and the export says so", async () => {
  storedRows = treeRecord();
  tappedSenses = new Map();
  const { csv, plain } = await buildAnkiExport(labels, async () => null);
  assert.equal(plain, true);
  const card = parse(csv).slice(2).find(([front]) => front === "tree");
  assert.equal(card?.[1], "enarbolar, árbol, fuste<br><br>i climbed the <b>tree</b>");
});

test("RL-92: a record of phrases alone has nothing the dictionary could add: not plain", async () => {
  storedRows = [treeRecord()[1]];
  const { plain } = await buildAnkiExport(labels, async () => null);
  assert.equal(plain, false);
});
