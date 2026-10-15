// RL-55: which settled lookups leave a row.
import assert from "node:assert/strict";
import { test } from "node:test";

import { isRecordedOutcome, RECORDED_OUTCOMES } from "./outcome";

test("isRecordedOutcome: a word the network answered is kept like a found one", () => {
  for (const outcome of ["exact", "inflected", "translated", "unlisted"] as const) {
    assert.equal(isRecordedOutcome(outcome), true, outcome);
  }
});

test("isRecordedOutcome: a miss and an untranslated sentence leave no row", () => {
  assert.equal(isRecordedOutcome("miss"), false);
  assert.equal(isRecordedOutcome("untranslated"), false);
  assert.equal(RECORDED_OUTCOMES.length, 4);
});
