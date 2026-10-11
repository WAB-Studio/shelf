import assert from "node:assert/strict";
import test from "node:test";

import { monthName, monthNameWithYear } from "./month-name";

test("monthName: this year's month is bare, another year's carries its year", () => {
  assert.equal(monthName("2026-12-01", "2026"), "diciembre");
  assert.equal(monthName("2027-12-01", "2026"), "diciembre de 2027");
  assert.equal(monthName("2025-03", "2026"), "marzo de 2025");
});

test("monthNameWithYear: the full four-digit year always, even this year's", () => {
  assert.equal(monthNameWithYear("2026-11-01"), "noviembre de 2026");
  assert.equal(monthNameWithYear("2027-12"), "diciembre de 2027");
});
