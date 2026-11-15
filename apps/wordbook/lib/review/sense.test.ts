// RL-78, RL-85 and RL-91: a card draws one sense, the one the reader tapped, else the one most plausibly meant.
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildIndex, groupFor, type Sense } from "@/lib/dictionary/index-build";
import type { RawEntry } from "@/lib/dictionary/format";

import { answerRanked, pickSense, senseChoiceFor } from "./sense";

const verb: Sense = { pos: "v", ipa: null, translations: ["apagar", "despabilar"], definition: "To put out." };
const noun: Sense = { pos: "n", ipa: null, translations: ["rapé"], definition: "Powdered tobacco." };
// Same part of speech and same first translation as `verb`, a different sense.
const twin: Sense = { pos: "v", ipa: null, translations: ["apagar", "sofocar"], definition: "To smother." };

test("the sense the reader tapped wins", () => {
  const senses = [verb, noun];
  assert.equal(pickSense(senses, senseChoiceFor("snuff", senses, noun)), noun);
  assert.equal(pickSense(senses, senseChoiceFor("snuff", senses, verb)), verb);
});

test("two senses with the same part of speech and first translation stay apart", () => {
  const senses = [verb, twin, noun];
  assert.equal(pickSense(senses, senseChoiceFor("snuff", senses, twin)), twin);
  assert.equal(pickSense(senses, senseChoiceFor("snuff", senses, verb)), verb);
});

test("a dictionary that reorders its senses still finds the one tapped by its signature", () => {
  const choice = senseChoiceFor("snuff", [verb, noun], noun);
  assert.equal(pickSense([noun, verb], choice), noun);
});

test("with no tap, or a tap no sense answers to, the first sense", () => {
  assert.equal(pickSense([verb, noun], null), verb);
  assert.equal(pickSense([verb, noun], { key: "snuff", index: 1, signature: "otra cosa" }), verb);
  assert.equal(pickSense([], senseChoiceFor("snuff", [noun], noun)), null);
});

// Invented entries under real headwords: `tree` has no measured order of parts of speech, `run` does (verb first).
const fixture: RawEntry[] = [
  ["tree", "v", null, ["enarbolar"], "(transitive) To place upon a shoe tree."],
  ["tree", "n", null, ["árbol", "fuste"], null],
  ["run", "n", null, ["partida", "carrera"], null],
  ["run", "v", null, ["correr", "marchar"], null],
];
const index = buildIndex({ version: 1, entries: fixture });

test("RL-91: with no tap and no measured order, a noun leads a verb: «tree» is «árbol», not «enarbolar»", () => {
  const group = groupFor(index, "tree")!;
  assert.equal(group.ranked, false);
  assert.equal(group.senses[0].pos, "v");
  assert.equal(pickSense(group.senses, null, group.ranked)?.translations[0], "árbol");
});

test("RL-91: a measured order stands: «run» keeps its verb first", () => {
  const group = groupFor(index, "run")!;
  assert.equal(group.ranked, true);
  assert.equal(pickSense(group.senses, null, group.ranked)?.translations[0], "correr");
});

test("RL-91: a suffix that fixes the part of speech counts as a reason for the order", () => {
  assert.equal(groupFor(index, "tree", "n")!.ranked, true);
  assert.equal(groupFor(index, "tree", "adj")!.ranked, false);
});

test("RL-91: a noun carrying a trade label does not outrank the first sense; a tap still wins over the default", () => {
  const species: Sense = { pos: "n", ipa: null, translations: ["pez"], definition: "(ichthyology) A fish (Abramis brama)." };
  const common: Sense = { pos: "v", ipa: null, translations: ["pescar"], definition: null };
  assert.equal(pickSense([common, species], null, false), common);
  assert.equal(pickSense([common, species], senseChoiceFor("fish", [common, species], species), false), species);
});

test("RL-91: an answer reads as ranked when its group carries no flag", () => {
  const answer = { query: "x", exact: { headword: "x", senses: [verb] }, viaInflection: [], correction: [] };
  assert.equal(answerRanked(answer), true);
  assert.equal(answerRanked({ ...answer, exact: null }), true);
});
