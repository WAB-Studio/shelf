import assert from "node:assert/strict";
import test from "node:test";

import { civilDay, dayBefore, yearWhenDifferent } from "./zone";

const BOGOTA = "America/Bogota";

test("20:30 in Bogota on a Thursday is still Thursday, though UTC says Friday", () => {
  const at = Date.parse("2026-10-30T01:30:00.000Z");
  assert.equal(civilDay(at, BOGOTA), "2026-10-29");
  assert.equal(civilDay(at, "UTC"), "2026-10-30");
});

test("the day turns at the zone's own midnight", () => {
  assert.equal(civilDay(Date.parse("2026-10-30T04:59:59.000Z"), BOGOTA), "2026-10-29");
  assert.equal(civilDay(Date.parse("2026-10-30T05:00:00.000Z"), BOGOTA), "2026-10-30");
});

test("a zone ahead of UTC files the evening under the next day", () => {
  const at = Date.parse("2026-10-29T20:30:00.000Z");
  assert.equal(civilDay(at, "Asia/Tokyo"), "2026-10-30");
  assert.equal(civilDay(at, "Pacific/Honolulu"), "2026-10-29");
});

test("dayBefore crosses months and years", () => {
  assert.equal(dayBefore("2026-03-01"), "2026-02-28");
  assert.equal(dayBefore("2026-01-01"), "2025-12-31");
  assert.equal(dayBefore("2024-03-01"), "2024-02-29");
});

test("the year is named only when it differs from now's, in the zone", () => {
  const now = Date.parse("2026-11-03T12:00:00.000Z");
  assert.deepEqual(yearWhenDifferent(Date.parse("2026-02-01T12:00:00.000Z"), now, BOGOTA), {});
  assert.deepEqual(yearWhenDifferent(Date.parse("2025-12-31T12:00:00.000Z"), now, BOGOTA), { year: "numeric" });
  // 2027-01-01 03:00Z is still 2026 in Bogota.
  assert.deepEqual(yearWhenDifferent(Date.parse("2027-01-01T03:00:00.000Z"), now, BOGOTA), {});
});
