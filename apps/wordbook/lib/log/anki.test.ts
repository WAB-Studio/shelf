// RL-72: the Anki CSV holds one quoted card per study group with a translation or a definition.
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAnkiCsv, cardBack, cardFront } from "./anki";
import type { StudyRow } from "./summary";

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
  // Mutation: drop `#html:false`.
  const lines = buildAnkiCsv([row("a")]).csv.split("\n");
  assert.deepEqual(lines.slice(0, 2), ["#separator:Comma", "#html:false"]);
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

test("commas, quotes and newlines round-trip through a CSV parser", () => {
  // Mutation: skip doubling `"`.
  const back = 'a, b "quoted"\nsecond line';
  const { csv } = buildAnkiCsv([row('say "hi", ok', { lastTranslation: back })]);
  assert.deepEqual(parse(csv).slice(2), [['say "hi", ok', back]]);
});

test("an empty study is the header alone", () => {
  const { csv, cards, skipped } = buildAnkiCsv([]);
  assert.equal(cards, 0);
  assert.equal(skipped, 0);
  assert.equal(csv, "#separator:Comma\n#html:false\n");
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
  assert.equal(csv, "#separator:Comma\n#html:false\n");
});

test("a definition with commas, quotes and newlines round-trips", () => {
  // Mutation: skip doubling `"`.
  const back = 'a, b "quoted"\nsecond line';
  const { csv } = buildAnkiCsv([row("w", { lastTranslation: null, lastDefinition: back })]);
  assert.deepEqual(parse(csv).slice(2), [["w", back]]);
});
