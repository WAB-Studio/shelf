// RL-76: which settled lookups leave a row.
import assert from "node:assert/strict";
import { test } from "node:test";

import { countKind, isPendingLookup, isRecordedLookup, RECORDED_OUTCOMES } from "./outcome";
import { LOOKUP_SCHEMA } from "./types";

const settled = (kind: "word" | "phrase", outcome: (typeof RECORDED_OUTCOMES)[number] | "miss" | "untranslated") => ({
  schema: LOOKUP_SCHEMA,
  kind,
  outcome,
});

test("isRecordedLookup: an answered lookup is kept, word or sentence", () => {
  for (const outcome of RECORDED_OUTCOMES) {
    assert.equal(isRecordedLookup(settled("word", outcome)), true, outcome);
    assert.equal(isRecordedLookup(settled("phrase", outcome)), true, outcome);
  }
  assert.equal(RECORDED_OUTCOMES.length, 4);
});

test("isRecordedLookup: a word miss is recorded pending, a phrase miss is not", () => {
  assert.equal(isRecordedLookup(settled("word", "miss")), true);
  assert.equal(isPendingLookup(settled("word", "miss")), true);
  assert.equal(isRecordedLookup(settled("phrase", "miss")), false);
  assert.equal(isPendingLookup(settled("phrase", "miss")), false);
});

test("isRecordedLookup: an untranslated sentence is recorded pending, an untranslated word is not", () => {
  assert.equal(isPendingLookup(settled("phrase", "untranslated")), true);
  assert.equal(isRecordedLookup(settled("word", "untranslated")), false);
});

test("isPendingLookup: a schema 3 miss and another device's miss never wait", () => {
  assert.equal(isPendingLookup({ ...settled("word", "miss"), schema: 3 }), false);
  assert.equal(isPendingLookup({ ...settled("word", "miss"), device: "other" }), false);
  assert.equal(isPendingLookup({ ...settled("word", "unlisted") }), false);
});

test("a count reads entries once a phrase is among the rows", () => {
  assert.equal(countKind([{ lastOutcome: "exact" }, { lastOutcome: "translated" }]), "entries");
  assert.equal(countKind([{ lastOutcome: "exact" }, { lastOutcome: "unlisted" }]), "words");
});
