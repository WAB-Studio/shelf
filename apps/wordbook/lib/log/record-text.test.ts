// RL-24: a row recorded longer than the wire admits could never be copied.
import assert from "node:assert/strict";
import { test } from "node:test";

import { clampForRecord, pendingRowFrom, RECORD_TEXT_MAX } from "./record-text";
import { LOOKUP_SCHEMA, type LookupRecord } from "./types";

const base: Omit<LookupRecord, "id" | "schema"> = {
  at: 1,
  text: "x",
  normalised: "x",
  kind: "word",
  outcome: "exact",
  headword: "x",
  rule: null,
  senses: 1,
  translation: null,
  dictionaryReady: true,
  origin: null,
};

test("clampForRecord: 689 characters come back as 500", () => {
  assert.equal([...clampForRecord("a".repeat(689))].length, RECORD_TEXT_MAX);
});

test("clampForRecord: an emoji on the boundary is not split", () => {
  const out = clampForRecord("a".repeat(499) + "😀" + "b".repeat(50));
  assert.equal(out, "a".repeat(499) + "😀");
  assert.equal([...out].length, 500);
  assert.equal(out.isWellFormed(), true);
});

test("clampForRecord: a 120-character phrase is untouched", () => {
  const phrase = "ab ".repeat(40);
  assert.equal(clampForRecord(phrase), phrase);
});

test("pendingRowFrom: a 600-character text and headword key are cut to RECORD_TEXT_MAX", () => {
  const row = pendingRowFrom({ ...base, text: "a".repeat(600), normalised: "b".repeat(600) });
  assert.equal([...row.text].length, RECORD_TEXT_MAX);
  assert.equal([...row.normalised].length, RECORD_TEXT_MAX);
  assert.equal(row.schema, LOOKUP_SCHEMA);
  assert.equal(row.id, undefined);
});

test("pendingRowFrom: definition and both examples are cut to RECORD_TEXT_MAX without splitting a pair", () => {
  const long = "a".repeat(499) + "😀" + "b".repeat(50);
  const row = pendingRowFrom({ ...base, definition: long, exampleEn: "c".repeat(600), exampleEs: long });
  assert.equal(row.definition, "a".repeat(499) + "😀");
  assert.equal([...row.exampleEn!].length, RECORD_TEXT_MAX);
  assert.equal(row.exampleEs, "a".repeat(499) + "😀");
  assert.equal(row.exampleEs!.isWellFormed(), true);
});

test("pendingRowFrom: absent or null answer fields stay as they came", () => {
  assert.equal(pendingRowFrom(base).definition, undefined);
  assert.equal(pendingRowFrom({ ...base, definition: null }).definition, null);
});

test("pendingRowFrom: the row is written at schema 3", () => {
  assert.equal(pendingRowFrom(base).schema, 3);
  assert.equal(LOOKUP_SCHEMA, 3);
});
