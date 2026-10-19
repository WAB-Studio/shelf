import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

import { createRecurringRuleSchema } from "./recurring-rule";

const TOO_EARLY = "recurringRules.errors.nextRunOnTooEarly";

afterEach(() => mock.timers.reset());

function setNow(iso: string) {
  mock.timers.enable({ apis: ["Date"], now: new Date(iso) });
}

function nextRunMessages(nextRunOn: string): string[] {
  const result = createRecurringRuleSchema.safeParse({
    fromAccountId: "11111111-1111-4111-8111-111111111111",
    toAccountId: null,
    amount: "50000",
    categoryId: "22222222-2222-4222-8222-222222222222",
    frequency: "monthly",
    dayOfMonth: 5,
    nextRunOn,
  });
  if (result.success) return [];
  return result.error.issues.filter((i) => i.path[0] === "nextRunOn").map((i) => i.message);
}

// Noon in Bogota, 2026-10-18.
const NOON = "2026-10-18T17:00:00Z";

test("a next run of 1900-01-01 is refused as too early", () => {
  setNow(NOON);
  assert.deepEqual(nextRunMessages("1900-01-01"), [TOO_EARLY]);
});

test("a next run exactly 12 months back is accepted", () => {
  setNow(NOON);
  assert.deepEqual(nextRunMessages("2025-10-18"), []);
});

test("a next run one day before the 12-month bound is refused", () => {
  setNow(NOON);
  assert.deepEqual(nextRunMessages("2025-10-17"), [TOO_EARLY]);
});

test("a future next run is still accepted", () => {
  setNow(NOON);
  assert.deepEqual(nextRunMessages("2027-01-01"), []);
});

test("the bound follows the person's day, not UTC's, near midnight", () => {
  // 03:00 UTC on the 19th is 22:00 on the 18th in Bogota: the bound is 2025-10-18.
  setNow("2026-10-19T03:00:00Z");
  assert.deepEqual(nextRunMessages("2025-10-18"), []);
  assert.deepEqual(nextRunMessages("2025-10-17"), [TOO_EARLY]);
});
