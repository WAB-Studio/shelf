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
  const { shown, folded } = splitRare([rareAdjective, verb]);
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
