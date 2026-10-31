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

test("a two-digit year is 20xx and digits alone are read as day, month, year", () => {
  assert.equal(textToIso("31/10/26", "dmy"), "2026-10-31");
  assert.equal(textToIso("31102026", "dmy"), "2026-10-31");
  assert.equal(textToIso("311026", "dmy"), "2026-10-31");
  assert.equal(textToIso("10312026", "mdy"), "2026-10-31");
  assert.equal(textToIso("31 10 2026", "dmy"), "2026-10-31");
  assert.equal(textToIso("3110", "dmy"), null);
  assert.equal(textToIso("32102026", "dmy"), null);
});
