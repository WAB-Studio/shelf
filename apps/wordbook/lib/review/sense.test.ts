// RL-78 and RL-85: a card draws one sense, the one the reader tapped.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Sense } from "@/lib/dictionary/index-build";

import { pickSense, senseChoiceFor } from "./sense";

const verb: Sense = { pos: "v", ipa: null, translations: ["apagar", "despabilar"], definition: "To put out." };
const noun: Sense = { pos: "n", ipa: null, translations: ["rapé"], definition: "Powdered tobacco." };

test("the sense the reader tapped wins", () => {
  assert.equal(pickSense([verb, noun], senseChoiceFor("snuff", noun)), noun);
  assert.equal(pickSense([verb, noun], senseChoiceFor("snuff", verb)), verb);
});

test("with no tap, or a tap no sense answers to, the first sense", () => {
  assert.equal(pickSense([verb, noun], null), verb);
  assert.equal(pickSense([verb, noun], { key: "snuff", pos: "n", translation: "otra cosa" }), verb);
  assert.equal(pickSense([], senseChoiceFor("snuff", noun)), null);
});

test("a choice names the sense by part of speech and first translation", () => {
  assert.deepEqual(senseChoiceFor("snuff", noun), { key: "snuff", pos: "n", translation: "rapé" });
});
