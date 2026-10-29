import assert from "node:assert/strict";
import test from "node:test";

import { monthOutsideSpan, removeMonthBudgetSchema, setMonthBudgetSchema } from "./budget";

const goalId = "6f1c1b7e-2d4a-4f3b-9c8e-1a2b3c4d5e6f";

function errorOf(input: unknown): string | null {
  const parsed = setMonthBudgetSchema.safeParse(input);
  return parsed.success ? null : parsed.error.issues[0].message;
}

test("setMonthBudgetSchema: a real month and an amount from 0 to 1 000 000 pass", () => {
  assert.equal(errorOf({ goalId, month: "2026-10", amount: 720 }), null);
  assert.equal(errorOf({ goalId, month: "2026-01", amount: 0 }), null);
  assert.equal(errorOf({ goalId, month: "2026-12", amount: 1_000_000 }), null);
});

test("setMonthBudgetSchema: a 13th month, a month 0 and a one-digit month are refused", () => {
  assert.equal(errorOf({ goalId, month: "2026-13", amount: 1 }), "month.errors.monthInvalid");
  assert.equal(errorOf({ goalId, month: "2026-00", amount: 1 }), "month.errors.monthInvalid");
  assert.equal(errorOf({ goalId, month: "2026-1", amount: 1 }), "month.errors.monthInvalid");
  assert.equal(errorOf({ goalId, month: "2026-10-01", amount: 1 }), "month.errors.monthInvalid");
});

test("setMonthBudgetSchema: −1, 1.5 and 1 000 001 are refused", () => {
  assert.equal(errorOf({ goalId, month: "2026-10", amount: -1 }), "month.errors.amountInvalid");
  assert.equal(errorOf({ goalId, month: "2026-10", amount: 1.5 }), "month.errors.amountInvalid");
  assert.equal(errorOf({ goalId, month: "2026-10", amount: 1_000_001 }), "month.errors.amountInvalid");
  assert.equal(errorOf({ goalId, month: "2026-10", amount: "720" }), "month.errors.amountInvalid");
});

test("setMonthBudgetSchema: a goalId that is not a uuid is refused", () => {
  assert.equal(errorOf({ goalId: "nope", month: "2026-10", amount: 1 }), "month.errors.invalid");
});

test("removeMonthBudgetSchema: takes the goal and the month, with the same month rule", () => {
  assert.equal(removeMonthBudgetSchema.safeParse({ goalId, month: "2026-10" }).success, true);
  assert.equal(removeMonthBudgetSchema.safeParse({ goalId, month: "2026-13" }).success, false);
});

test("monthOutsideSpan: the opening's month is in, the one before is out", () => {
  const span = { openedOn: "2026-09-15", horizon: "2027-01-10" };
  assert.equal(monthOutsideSpan({ ...span, month: "2026-09" }), false);
  assert.equal(monthOutsideSpan({ ...span, month: "2026-08" }), true);
});

test("monthOutsideSpan: the last day's month is in, the one after is out", () => {
  const span = { openedOn: "2026-09-15", horizon: "2027-01-10" };
  assert.equal(monthOutsideSpan({ ...span, month: "2027-01" }), false);
  assert.equal(monthOutsideSpan({ ...span, month: "2027-02" }), true);
});

test("monthOutsideSpan: a horizon on the 1st leaves its own month out", () => {
  const span = { openedOn: "2026-09-15", horizon: "2027-01-01" };
  assert.equal(monthOutsideSpan({ ...span, month: "2026-12" }), false);
  assert.equal(monthOutsideSpan({ ...span, month: "2027-01" }), true);
});
