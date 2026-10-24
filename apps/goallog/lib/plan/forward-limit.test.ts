import assert from "node:assert/strict";
import test from "node:test";

import { forwardLimit, lastMondayOf } from "./forward-limit";

const TODAY = "2026-10-22";

test("the limit is the last month of the furthest open goal", () => {
  // A horizon is the first day after the goal: 2027-04-01 ends a goal in March.
  assert.equal(forwardLimit({ horizons: ["2027-04-01", "2026-12-31"], today: TODAY }), "2027-03");
  assert.equal(forwardLimit({ horizons: ["2027-03-15"], today: TODAY }), "2027-03");
});

test("a goal with no end counts twelve months from today", () => {
  assert.equal(forwardLimit({ horizons: [null], today: TODAY }), "2027-10");
  assert.equal(forwardLimit({ horizons: ["2027-04-01", null], today: TODAY }), "2027-10");
});

test("no open goal leaves this month", () => {
  assert.equal(forwardLimit({ horizons: [], today: TODAY }), "2026-10");
});

test("a goal that already ended does not stretch the limit", () => {
  assert.equal(forwardLimit({ horizons: ["2026-10-22", "2026-05-01"], today: TODAY }), "2026-10");
});

test("a goal ending this month holds the limit at this month", () => {
  assert.equal(forwardLimit({ horizons: ["2026-10-31"], today: TODAY }), "2026-10");
});

test("the last Monday is the Monday of the week holding the limit month's last day", () => {
  assert.equal(lastMondayOf("2026-10"), "2026-10-26");
  assert.equal(lastMondayOf("2026-11"), "2026-11-30");
  assert.equal(lastMondayOf("2027-02"), "2027-02-22");
});
