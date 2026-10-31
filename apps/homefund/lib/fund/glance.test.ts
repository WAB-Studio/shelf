import assert from "node:assert/strict";
import { test } from "node:test";

import {
  averageOfActive,
  budgetTotals,
  CHART_PALETTE,
  chartColor,
  dayNet,
  groupByDay,
  nearestLimit,
  nextDebtPayment,
  shares,
  topWithRest,
} from "./glance";

test("nearestLimit lists the fullest budgets first and skips a zero limit", () => {
  const rows = [
    { id: "a", limitCents: 100, spentCents: 50, currency: "COP" },
    { id: "b", limitCents: 100, spentCents: 120, currency: "COP" },
    { id: "c", limitCents: 0, spentCents: 10, currency: "COP" },
    { id: "d", limitCents: 200, spentCents: 190, currency: "COP" },
  ];
  assert.deepEqual(nearestLimit(rows, 2).map((row) => row.id), ["b", "d"]);
});

test("nextDebtPayment picks the earliest due date among debts that owe", () => {
  const next = nextDebtPayment([
    { accountId: "x", currency: "COP", owedCents: 0, minimumPaymentCents: 5, nextDueDate: "2026-11-01" },
    { accountId: "y", currency: "COP", owedCents: 9, minimumPaymentCents: 700, nextDueDate: "2026-11-10" },
    { accountId: "z", currency: "COP", owedCents: 9, minimumPaymentCents: null, nextDueDate: "2026-11-20" },
  ]);
  assert.deepEqual(next, { accountId: "y", currency: "COP", amountCents: 700, date: "2026-11-10" });
  assert.equal(nextDebtPayment([]), null);
});

test("shares always add up to 100", () => {
  for (const values of [[1, 1, 1], [5, 3, 2], [7, 7, 7, 7, 7, 7, 7], [1]]) {
    assert.equal(shares(values).reduce((a, b) => a + b, 0), 100);
  }
  assert.deepEqual(shares([0, 0]), [0, 0]);
});

test("topWithRest folds the tail into one remainder", () => {
  const { top, restCents } = topWithRest(
    [{ totalCents: 5 }, { totalCents: 40 }, { totalCents: 30 }, { totalCents: 25 }],
    2,
  );
  assert.deepEqual(top.map((row) => row.totalCents), [40, 30]);
  assert.equal(restCents, 30);
});

test("averageOfActive ignores empty months", () => {
  assert.equal(averageOfActive([0, 100, 300, 0]), 200);
  assert.equal(averageOfActive([0, 0]), null);
});

test("groupByDay keeps first-seen order", () => {
  const groups = groupByDay([
    { occurredAt: "2026-10-30", n: 1 },
    { occurredAt: "2026-10-30", n: 2 },
    { occurredAt: "2026-10-29", n: 3 },
  ]);
  assert.deepEqual(groups.map((group) => [group.date, group.rows.length]), [
    ["2026-10-30", 2],
    ["2026-10-29", 1],
  ]);
});

test("budgetTotals sums per currency and never across them", () => {
  const totals = budgetTotals([
    { id: "a", limitCents: 100, spentCents: 40, currency: "COP" },
    { id: "b", limitCents: 50, spentCents: 60, currency: "USD" },
    { id: "c", limitCents: 200, spentCents: 10, currency: "COP" },
  ]);
  assert.deepEqual(totals, [
    { currency: "COP", limitCents: 300, spentCents: 50 },
    { currency: "USD", limitCents: 50, spentCents: 60 },
  ]);
});

test("dayNet counts income and expense only, per currency", () => {
  const row = (kind: string, amountCents: number, reconciliationId: string | null = null, currency = "COP") => ({
    kind, currency, amountCents, reconciliationId,
  });
  assert.deepEqual(
    dayNet([row("income", 500), row("expense", 200), row("transfer", 999), row("expense", 50, "r1")]),
    [["COP", 300]],
  );
  assert.deepEqual(dayNet([]), []);
});

test("chartColor is stable per key and stays inside the palette", () => {
  assert.equal(chartColor("abc"), chartColor("abc"));
  for (const key of ["a", "b", "Arriendo", "0b5f6a52-6f3b-4c4b-9f64-8c1f0f1d7a11"]) {
    assert.ok((CHART_PALETTE as readonly string[]).includes(chartColor(key)));
  }
});
