import assert from "node:assert/strict";
import { test } from "node:test";

import { addCivilDays, todayInBogota } from "@/lib/dates";

import { reconcileAccountSchema } from "./account-reconciliation";

const accountId = "0b2f6a54-7a3c-4f43-9a55-6d5a1e8f3c11";

function parse(overrides: Record<string, unknown>) {
  return reconcileAccountSchema.safeParse({
    accountId,
    reconciledOn: todayInBogota(),
    realAmount: "480000",
    expectedDerivedCents: 48_000_000,
    ...overrides,
  });
}

function messages(result: ReturnType<typeof parse>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

test("a count dated today or earlier is accepted", () => {
  assert.equal(parse({ reconciledOn: todayInBogota() }).success, true);
  assert.equal(parse({ reconciledOn: addCivilDays(todayInBogota(), -1) }).success, true);
  assert.equal(parse({ reconciledOn: addCivilDays(todayInBogota(), -400) }).success, true);
});

test("a count dated after today is refused with the future-day message, before the database is asked", () => {
  for (const ahead of [1, 2, 365]) {
    const result = parse({ reconciledOn: addCivilDays(todayInBogota(), ahead) });
    assert.equal(result.success, false, `${ahead} day(s) ahead was accepted`);
    assert.deepEqual(messages(result), ["errors.reconcileFutureDay"]);
  }
});

test("a day that is not on the calendar is refused as an invalid date, not as a future one", () => {
  for (const day of ["2026-02-30", "not-a-day", ""]) {
    const result = parse({ reconciledOn: day });
    assert.equal(result.success, false, `${JSON.stringify(day)} was accepted`);
    assert.deepEqual(messages(result), ["transactions.errors.dateInvalid"]);
  }
});

test("a real figure of zero is a count, a negative one is not", () => {
  assert.equal(parse({ realAmount: "0" }).success, true);
  const negative = parse({ realAmount: "-5000" });
  assert.equal(negative.success, false);
  assert.deepEqual(messages(negative), ["transactions.errors.amountInvalid"]);
});
