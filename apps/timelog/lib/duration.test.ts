import assert from "node:assert/strict";
import { test } from "node:test";

import { briefDuration, durationParts, formatDuration } from "./duration";

const words = { hours: "h", minutes: "min", underMinute: "< 1 min" };

test("a duration reads in whole hours and minutes, floored", () => {
  assert.equal(formatDuration(0, words), "< 1 min");
  assert.equal(formatDuration(59, words), "< 1 min");
  assert.equal(formatDuration(60, words), "1 min");
  assert.equal(formatDuration(45 * 60 + 59, words), "45 min");
  assert.equal(formatDuration(2 * 3600, words), "2 h");
  assert.equal(formatDuration(3 * 3600 + 12 * 60 + 30, words), "3 h 12 min");
});

test("a duration splits into figure and unit pairs", () => {
  assert.deepEqual(durationParts(30, words), [{ value: "< 1", unit: "min" }]);
  assert.deepEqual(durationParts(45 * 60, words), [{ value: "45", unit: "min" }]);
  assert.deepEqual(durationParts(2 * 3600, words), [{ value: "2", unit: "h" }]);
  assert.deepEqual(durationParts(3 * 3600 + 12 * 60, words), [
    { value: "3", unit: "h" },
    { value: "12", unit: "min" },
  ]);
});

test("a brief duration keeps the largest unit, floored", () => {
  assert.equal(briefDuration(30, words), "< 1 min");
  assert.equal(briefDuration(45 * 60 + 59, words), "45 min");
  assert.equal(briefDuration(3600, words), "1 h");
  assert.equal(briefDuration(12 * 3600 + 59 * 60, words), "12 h");
});
