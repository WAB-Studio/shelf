// RL-78 and RL-85: a card draws one sense, the one the reader tapped.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Sense } from "@/lib/dictionary/index-build";

import { pickSense, senseChoiceFor } from "./sense";

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
