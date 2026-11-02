import assert from "node:assert/strict";
import { test } from "node:test";

import type { Sense } from "./index-build";
import { splitRare } from "./rare-sense";

const verb: Sense = { pos: "v", ipa: null, translations: ["cegar"], definition: "(transitive) To make blind." };
const rareAdjective: Sense = {
  pos: "adj",
  ipa: null,
  translations: ["ciego"],
  definition: "(informatics) Unable to see.",
};

test("splitRare folds a rare sense while a common one stands", () => {
  const { shown, folded } = splitRare([verb, rareAdjective]);
  assert.deepEqual(shown, [verb]);
  assert.deepEqual(folded, [rareAdjective]);
});

test("splitRare folds nothing when every sense is rare", () => {
  const { shown, folded } = splitRare([rareAdjective]);
  assert.deepEqual(shown, [rareAdjective]);
  assert.deepEqual(folded, []);
});

test("splitRare folds nothing on a compact block", () => {
  const { shown, folded } = splitRare([rareAdjective, verb], true);
  assert.deepEqual(shown, [rareAdjective, verb]);
  assert.deepEqual(folded, []);
});

test("splitRare keeps a rare sense of a more frequent part of speech: blind's adjective stands before the verb", () => {
  const { shown, folded } = splitRare([rareAdjective, verb]);
  assert.deepEqual(shown, [rareAdjective, verb]);
  assert.deepEqual(folded, []);
});

test("splitRare still folds a rare sense of the common sense's own part of speech, or of a rarer one", () => {
  const rareVerb: Sense = { pos: "v", ipa: null, translations: ["x"], definition: "(informatics) To x." };
  const rareNoun: Sense = { pos: "n", ipa: null, translations: ["y"], definition: "(informatics) A y." };
  assert.deepEqual(splitRare([verb, rareVerb, rareNoun]).folded, [rareVerb, rareNoun]);
});
