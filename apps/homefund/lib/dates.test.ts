import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { nextDayOfMonthOnOrAfter, previousDayOfMonthOnOrBefore, todayInBogota } from "./dates";

// Bogotá is UTC-5 all year, so its day turns over at 05:00 UTC.
function dayAt(instant: string): string {
  mock.timers.enable({ apis: ["Date"], now: new Date(instant) });
  return todayInBogota();
}

describe("todayInBogota", () => {
  afterEach(() => mock.timers.reset());

  it("is still the previous day at 19:00 Bogotá, when UTC has turned over", () => {
    assert.equal(dayAt("2026-10-19T00:00:00Z"), "2026-10-18");
  });

  it("is still the previous day at 23:59:59 Bogotá", () => {
    assert.equal(dayAt("2026-10-19T04:59:59Z"), "2026-10-18");
  });

  it("turns over at 00:00 Bogotá", () => {
    assert.equal(dayAt("2026-10-19T05:00:00Z"), "2026-10-19");
  });

  it("is the same day at midday", () => {
    assert.equal(dayAt("2026-10-18T17:00:00Z"), "2026-10-18");
  });
});

describe("the cut-off and due dates a card's stored days propose", () => {
  it("takes the latest cut-off on or before a day, in this month or the last", () => {
    assert.equal(previousDayOfMonthOnOrBefore(15, "2026-11-17"), "2026-11-15");
    assert.equal(previousDayOfMonthOnOrBefore(15, "2026-11-15"), "2026-11-15");
    assert.equal(previousDayOfMonthOnOrBefore(20, "2026-11-17"), "2026-10-20");
  });

  it("clamps a day past the month's end and crosses the year", () => {
    assert.equal(previousDayOfMonthOnOrBefore(31, "2026-03-01"), "2026-02-28");
    assert.equal(previousDayOfMonthOnOrBefore(20, "2026-01-05"), "2025-12-20");
  });

  it("puts the due day after the cut-off it follows", () => {
    assert.equal(nextDayOfMonthOnOrAfter(30, "2026-11-16"), "2026-11-30");
    assert.equal(nextDayOfMonthOnOrAfter(5, "2026-11-16"), "2026-12-05");
  });
});
