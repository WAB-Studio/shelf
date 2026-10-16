import assert from "node:assert/strict";
import test from "node:test";

import { movedSpan } from "./moved-span";

test("movedSpan: six days read in days, exactly seven read as one week", () => {
  assert.deepEqual(movedSpan(6), { short: true, weeks: 1 });
  assert.deepEqual(movedSpan(7), { short: false, weeks: 1 });
});

test("movedSpan: weeks round to the nearest, 11 days are two", () => {
  assert.equal(movedSpan(10).weeks, 1);
  assert.equal(movedSpan(11).weeks, 2);
  assert.equal(movedSpan(14).weeks, 2);
});
