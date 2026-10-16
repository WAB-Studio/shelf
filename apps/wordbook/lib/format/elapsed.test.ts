// RNL-02's contract: under a minute is "a moment", then minutes, hours and
// days, never a value below one and never a negative one.
import assert from "node:assert/strict";
import { test } from "node:test";

import { elapsed } from "./elapsed";

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const NOW = 1_800_000_000_000;

test("under a minute is a moment", () => {
  assert.deepEqual(elapsed(NOW, NOW), { unit: "moment" });
  assert.deepEqual(elapsed(NOW - 59 * S, NOW), { unit: "moment" });
});

test("minutes, rounded, below an hour", () => {
  assert.deepEqual(elapsed(NOW - 60 * S, NOW), { unit: "minute", value: 1 });
  assert.deepEqual(elapsed(NOW - (59 * MIN + 29 * S), NOW), {
    unit: "minute",
    value: 59,
  });
});

test("hours below a day", () => {
  assert.deepEqual(elapsed(NOW - 60 * MIN, NOW), { unit: "hour", value: 1 });
  assert.deepEqual(elapsed(NOW - (23 * H + 29 * MIN), NOW), {
    unit: "hour",
    value: 23,
  });
});

test("days from 24 hours", () => {
  assert.deepEqual(elapsed(NOW - 24 * H, NOW), { unit: "day", value: 1 });
});

test("a future instant is a moment", () => {
  assert.deepEqual(elapsed(NOW + 5 * MIN, NOW), { unit: "moment" });
});
