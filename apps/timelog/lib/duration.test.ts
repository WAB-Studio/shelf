import assert from "node:assert/strict";
import { test } from "node:test";

import { formatDuration } from "./duration";

const words = { hours: "h", minutes: "min", underMinute: "< 1 min" };

test("a duration reads in whole hours and minutes, floored", () => {
  assert.equal(formatDuration(0, words), "< 1 min");
  assert.equal(formatDuration(59, words), "< 1 min");
  assert.equal(formatDuration(60, words), "1 min");
  assert.equal(formatDuration(45 * 60 + 59, words), "45 min");
  assert.equal(formatDuration(2 * 3600, words), "2 h");
  assert.equal(formatDuration(3 * 3600 + 12 * 60 + 30, words), "3 h 12 min");
});
