import assert from "node:assert/strict";
import test from "node:test";

import { closedMonthMarkDay } from "./closed-month-marks";

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
