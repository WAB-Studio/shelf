import assert from "node:assert/strict";
import test from "node:test";

import { closedMonthMarkDay, writableFrom } from "./closed-month-marks";

test("a closed month marks on its last day through the seventh day after it", () => {
  assert.equal(closedMonthMarkDay("2026-10-01", "2026-11-01"), "2026-10-31");
  assert.equal(closedMonthMarkDay("2026-10", "2026-11-07"), "2026-10-31");
  assert.equal(closedMonthMarkDay("2026-02-01", "2026-03-07"), "2026-02-28");
});

test("from the eighth day after it, and for the month still open, nothing marks", () => {
  assert.equal(closedMonthMarkDay("2026-10-01", "2026-11-08"), null);
  assert.equal(closedMonthMarkDay("2026-09-01", "2026-11-02"), null);
  assert.equal(closedMonthMarkDay("2026-10-01", "2026-10-31"), null);
});

test("facts change from last month's first while it marks, from this month's first after", () => {
  assert.equal(writableFrom("2026-11-07"), "2026-10-01");
  assert.equal(writableFrom("2026-11-08"), "2026-11-01");
  assert.equal(writableFrom("2026-10-28"), "2026-10-01");
});
