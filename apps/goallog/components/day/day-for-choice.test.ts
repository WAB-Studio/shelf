import assert from "node:assert/strict";
import test from "node:test";

import { dayForChoice } from "./day-for-choice";

const pick = (kind: "today" | "tomorrow" | "other" | "none", date = "") => ({ kind, date });

test("dayForChoice: hoy is the day given", () => {
  assert.equal(dayForChoice(pick("today"), "2026-09-28"), "2026-09-28");
});

test("dayForChoice: mañana crosses a month end, a year end and a leap day", () => {
  assert.equal(dayForChoice(pick("tomorrow"), "2026-09-30"), "2026-10-01");
  assert.equal(dayForChoice(pick("tomorrow"), "2026-12-31"), "2027-01-01");
  assert.equal(dayForChoice(pick("tomorrow"), "2028-02-28"), "2028-02-29");
  assert.equal(dayForChoice(pick("tomorrow"), "2027-02-28"), "2027-03-01");
});

test("dayForChoice: otro día is the date picked, sin día is null", () => {
  assert.equal(dayForChoice(pick("other", "2026-10-15"), "2026-09-28"), "2026-10-15");
  assert.equal(dayForChoice(pick("none", "2026-10-15"), "2026-09-28"), null);
});
