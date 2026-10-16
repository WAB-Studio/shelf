import assert from "node:assert/strict";
import { test } from "node:test";

import { addCivilDays, todayInBogota } from "@/lib/dates";

import {
  checkRealAmount,
  importedAdjustmentSchema,
  reconcileAccountSchema,
} from "./account-reconciliation";

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

const INVALID = "transactions.errors.amountInvalid";
const REQUIRED = "errors.reconcileRealRequired";
const TOO_LARGE = "transactions.errors.amountTooLarge";

test("a real figure of zero is a count, and so is one below zero typed with a leading minus", () => {
  assert.equal(parse({ realAmount: "0" }).success, true);
  assert.equal(parse({ realAmount: "-5000" }).success, true);
  assert.equal(parse({ realAmount: "\u22125000" }).success, true);
});

test("the form schema refuses what checkRealAmount refuses, with the same key", () => {
  const cases: [string, string][] = [
    ["-", INVALID],
    ["\u2212", INVALID],
    ["--5", INVALID],
    ["5-", INVALID],
    ["- 5", INVALID],
    ["+5", INVALID],
    ["-+5", INVALID],
    ["-999999999999", TOO_LARGE],
  ];
  for (const [value, key] of cases) {
    const result = parse({ realAmount: value });
    assert.equal(result.success, false, `${JSON.stringify(value)} was accepted`);
    assert.deepEqual(messages(result), [key], JSON.stringify(value));
  }
});

test("a hyphen-minus and a true minus read as negative integer cents", () => {
  assert.deepEqual(checkRealAmount("-5000", "COP"), { ok: true, cents: -500_000 });
  assert.deepEqual(checkRealAmount("\u221212,34", "USD"), { ok: true, cents: -1234 });
  assert.deepEqual(checkRealAmount("\u22125.000", "COP"), { ok: true, cents: -500_000 });
});

test("outer whitespace is allowed around a signed figure", () => {
  assert.deepEqual(checkRealAmount(" -5000 ", "COP"), { ok: true, cents: -500_000 });
  assert.deepEqual(checkRealAmount("  \u22125000\t", "COP"), { ok: true, cents: -500_000 });
});

test("minus zero is zero, never negative zero", () => {
  for (const value of ["-0", "\u22120", "-0,00"]) {
    const result = checkRealAmount(value, "COP");
    assert.deepEqual(result, { ok: true, cents: 0 }, value);
    assert.equal(result.ok && Object.is(result.cents, 0), true, `${value} gave -0`);
  }
});

test("a bare sign is an invalid figure, not a blank one", () => {
  for (const value of ["-", "\u2212", " - "]) {
    assert.deepEqual(checkRealAmount(value, "COP"), { ok: false, messageKey: INVALID }, value);
  }
});

test("a malformed sign is refused as invalid: doubled, trailing, spaced, plus", () => {
  const values = [
    "--5", "\u2212-5", "-\u22125", "\u2212\u22125", "5-", "5\u2212", "- 5", "\u2212 5",
    "+5", "-+5", "+-5", "-5-",
  ];
  for (const value of values) {
    assert.deepEqual(checkRealAmount(value, "COP"), { ok: false, messageKey: INVALID }, value);
  }
});

test("the cap reads the magnitude of a signed figure", () => {
  assert.deepEqual(checkRealAmount("-999999999999", "COP"), {
    ok: false,
    messageKey: TOO_LARGE,
  });
  assert.deepEqual(checkRealAmount("\u2212999999999999", "COP"), {
    ok: false,
    messageKey: TOO_LARGE,
  });
});

test("a movement amount stays unsigned: an imported adjustment refuses a minus", () => {
  const base = {
    adjustment: true,
    accountId,
    direction: "down",
    occurredAt: addCivilDays(todayInBogota(), -1),
  };
  assert.equal(importedAdjustmentSchema.safeParse({ ...base, amount: "5" }).success, true);
  for (const amount of ["-5", "\u22125"]) {
    assert.equal(
      importedAdjustmentSchema.safeParse({ ...base, amount }).success,
      false,
      `${amount} was accepted`,
    );
  }
});

test("checkRealAmount reads a written figure as integer cents of the account's currency", async () => {
  const { checkRealAmount } = await import("./account-reconciliation");
  assert.deepEqual(checkRealAmount("12.000", "COP"), { ok: true, cents: 1_200_000 });
  assert.deepEqual(checkRealAmount("0", "COP"), { ok: true, cents: 0 });
  assert.deepEqual(checkRealAmount("12.34", "USD"), { ok: true, cents: 1234 });
});

test("checkRealAmount refuses with the schema's own key, never the fallback", async () => {
  const { checkRealAmount } = await import("./account-reconciliation");
  assert.deepEqual(checkRealAmount("12,3456", "COP"), {
    ok: false,
    messageKey: "transactions.errors.amountInvalid",
  });
  for (const value of ["abc", "1e5"]) {
    assert.deepEqual(checkRealAmount(value, "COP"), {
      ok: false,
      messageKey: "transactions.errors.amountInvalid",
    });
  }
  assert.deepEqual(checkRealAmount("", "COP"), {
    ok: false,
    messageKey: "errors.reconcileRealRequired",
  });
  assert.deepEqual(checkRealAmount("   ", "COP"), {
    ok: false,
    messageKey: "errors.reconcileRealRequired",
  });
  assert.deepEqual(checkRealAmount("999999999999", "COP"), {
    ok: false,
    messageKey: "transactions.errors.amountTooLarge",
  });
});
