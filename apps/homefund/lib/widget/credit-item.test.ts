import assert from "node:assert/strict";
import { test } from "node:test";

import { daysUntilDue, widgetCredit } from "./credit-item";

test("days until the due day count from today, 0 on the day, into the next month once it has passed", () => {
  assert.equal(daysUntilDue(15, "2026-11-09"), 6);
  assert.equal(daysUntilDue(9, "2026-11-09"), 0);
  assert.equal(daysUntilDue(5, "2026-11-09"), 26);
  assert.equal(daysUntilDue(31, "2026-11-09"), 21);
  assert.equal(daysUntilDue(15, "2026-12-20"), 26);
  assert.equal(daysUntilDue(null, "2026-11-09"), null);
});

test("the payer's month is done at the installment, partial below it and none with no transfer", () => {
  const credit = (paidCents: number) => ({
    personName: "John", currency: "COP", installmentCents: 20_000_000, dueDay: 15,
    months: [
      { month: "2026-11", paidCents, paidOn: null, lenderCents: 0, lenderOn: null },
      { month: "2026-10", paidCents: 20_000_000, paidOn: "2026-10-03", lenderCents: 0, lenderOn: null },
    ],
  });
  assert.equal(widgetCredit(credit(20_000_000), "2026-11-09").paidThisMonth, "done");
  assert.equal(widgetCredit(credit(5_000_000), "2026-11-09").paidThisMonth, "partial");
  assert.equal(widgetCredit(credit(0), "2026-11-09").paidThisMonth, "none");
  assert.deepEqual(widgetCredit(credit(0), "2026-11-09"), {
    person: "John", currency: "COP", paidThisMonth: "none", installmentCents: 20_000_000, daysUntilDue: 6,
  });
});
