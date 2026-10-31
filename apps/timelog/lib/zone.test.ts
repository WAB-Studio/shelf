import assert from "node:assert/strict";
import { test } from "node:test";

import { addDays, civilDay, dayStart, isCivilDay } from "./zone";

test("the civil day is Bogotá's: 03:00 UTC is still yesterday there", () => {
  assert.equal(civilDay(new Date("2026-10-29T03:00:00Z")), "2026-10-28");
  assert.equal(civilDay(new Date("2026-10-29T05:00:00Z")), "2026-10-29");
});

test("only real calendar days are days", () => {
  assert.ok(isCivilDay("2028-02-29"));
  for (const value of ["2026-02-29", "2026-13-01", "2026-1-01", "hoy"]) assert.equal(isCivilDay(value), false, value);
});

test("addDays crosses months and years", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("a civil day begins at five in the morning UTC, Bogotá being five hours behind", () => {
  assert.equal(dayStart("2026-10-30").toISOString(), "2026-10-30T05:00:00.000Z");
  assert.equal(dayStart("2026-11-01").toISOString(), "2026-11-01T05:00:00.000Z");
});
