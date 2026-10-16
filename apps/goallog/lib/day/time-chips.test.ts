import assert from "node:assert/strict";
import test from "node:test";

import { timeChipsAround } from "./time-chips";

test("a 90-minute target is the board's spread, target included", () => {
  assert.deepEqual(timeChipsAround(90), [30, 45, 60, 75, 90, 120, 150, 180]);
});

test("a 10-minute target steps by 5 and keeps every chip above zero", () => {
  assert.deepEqual(timeChipsAround(10), [5, 10, 15, 20, 25]);
});

test("a 30-minute target steps by 5 both ways", () => {
  assert.deepEqual(timeChipsAround(30), [10, 15, 20, 25, 30, 35, 40, 45]);
});

test("a 45-minute target reaches the hour", () => {
  assert.deepEqual(timeChipsAround(45), [25, 30, 35, 40, 45, 50, 55, 60]);
});

test("a 4-hour target stays at eight whole, ascending chips", () => {
  assert.deepEqual(timeChipsAround(240), [180, 195, 210, 225, 240, 270, 300, 330]);
});

test("every spread is ascending, distinct, whole and positive", () => {
  for (let target = 1; target <= 600; target++) {
    const chips = timeChipsAround(target);
    assert.ok(chips.includes(target));
    assert.ok(chips.length <= 8);
    chips.forEach((chip, i) => {
      assert.ok(Number.isInteger(chip) && chip > 0);
      if (i > 0) assert.ok(chip > chips[i - 1]);
    });
  }
});
