// RL-79: a card draws one sense, the one the reader saw.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Sense } from "@/lib/dictionary/index-build";

import { pickSense } from "./sense";

const verb: Sense = { pos: "v", ipa: null, translations: ["apagar", "despabilar"], definition: "To put out." };
const noun: Sense = { pos: "n", ipa: null, translations: ["rapé"], definition: "Powdered tobacco." };

test("the sense whose translations the record kept wins", () => {
  assert.equal(pickSense([verb, noun], "rapé"), noun);
  assert.equal(pickSense([verb, noun], "apagar, despabilar, rapé"), verb);
});

test("with nothing in common, or no record, the first sense", () => {
  assert.equal(pickSense([verb, noun], "otra cosa"), verb);
  assert.equal(pickSense([verb, noun], null), verb);
  assert.equal(pickSense([], "rapé"), null);
});
