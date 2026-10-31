import assert from "node:assert/strict";
import { test } from "node:test";

import { isoToText, textToIso } from "./date-text";

test("a civil date reads in the locale's order and comes back unchanged", () => {
  assert.equal(isoToText("2026-10-31", "dmy"), "31/10/2026");
  assert.equal(isoToText("2026-10-31", "mdy"), "10/31/2026");
  assert.equal(isoToText("", "dmy"), "");
  assert.equal(textToIso("31/10/2026", "dmy"), "2026-10-31");
  assert.equal(textToIso("10/31/2026", "mdy"), "2026-10-31");
  assert.equal(textToIso("1/2/2026", "dmy"), "2026-02-01");
});

test("the ISO form is always accepted and a day that does not exist is refused", () => {
  assert.equal(textToIso("2026-10-31", "dmy"), "2026-10-31");
  assert.equal(textToIso("31/02/2026", "dmy"), null);
  assert.equal(textToIso("31/10", "dmy"), null);
  assert.equal(textToIso("", "dmy"), null);
});
