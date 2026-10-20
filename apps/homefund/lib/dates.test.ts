import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { todayInBogota } from "./dates";

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
