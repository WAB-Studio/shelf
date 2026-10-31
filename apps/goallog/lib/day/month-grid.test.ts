import assert from "node:assert/strict";
import test from "node:test";

import { monthGrid } from "./month-grid";

test("october 2026 is five Monday-first weeks", () => {
  const weeks = monthGrid("2026-10", {});
  assert.equal(weeks.length, 5);
  assert.equal(weeks[0][0].day, "2026-09-28");
  assert.equal(weeks[0][0].inMonth, false);
  assert.equal(weeks[0][3].day, "2026-10-01");
  assert.equal(weeks[4][6].day, "2026-11-01");
  assert.ok(weeks.every((week) => week.length === 7));
});

test("intensity is the day's count against the busiest day, in four steps", () => {
  const weeks = monthGrid("2026-10", { "2026-10-01": 1, "2026-10-02": 4, "2026-10-03": 8, "2026-10-05": 0 });
  const level = (day: string) => weeks.flat().find((cell) => cell.day === day)?.level;
  assert.equal(level("2026-10-03"), 4);
  assert.equal(level("2026-10-02"), 2);
  assert.equal(level("2026-10-01"), 1);
  assert.equal(level("2026-10-05"), 0);
  assert.equal(level("2026-10-06"), 0);
});

test("a day outside the month never carries a level", () => {
  const weeks = monthGrid("2026-10", { "2026-09-30": 9, "2026-10-10": 2 });
  assert.equal(weeks[0][2].day, "2026-09-30");
  assert.equal(weeks[0][2].level, 0);
});
