import assert from "node:assert/strict";
import { test } from "node:test";

import { creditHistory, HISTORY_MONTHS, monthOf, sideState, type CreditMonth } from "./third-party-credit";
import { setUpThirdPartyCreditSchema, recordThirdPartyPaymentSchema } from "./validation/third-party-credit";

const month = (m: string, paidCents: number, lenderCents: number): CreditMonth => ({
  month: m,
  paidCents,
  paidOn: paidCents > 0 ? `${m}-05` : null,
  lenderCents,
  lenderOn: lenderCents > 0 ? `${m}-06` : null,
});

test("a month with no transfer is still a line, newest first", () => {
  const history = creditHistory([month("2026-09", 50_00, 50_00), month("2026-11", 0, 50_00)], "2026-09", "2026-11");
  assert.deepEqual(
    history.map((row) => row.month),
    ["2026-11", "2026-10", "2026-09"],
  );
  assert.equal(history[1].paidCents, 0);
  assert.equal(history[1].lenderOn, null);
});

test("the history starts at the earliest trace, even before the opening month", () => {
  const history = creditHistory([month("2026-07", 0, 10_00)], "2026-09", "2026-09");
  assert.equal(history.at(-1)?.month, "2026-07");
});

test("the year turns over", () => {
  const history = creditHistory([], "2026-11", "2027-02");
  assert.deepEqual(
    history.map((row) => row.month),
    ["2027-02", "2027-01", "2026-12", "2026-11"],
  );
});

test("the history keeps the latest months only", () => {
  assert.equal(creditHistory([], "2020-01", "2026-11").length, HISTORY_MONTHS);
});

test("a month is read off a civil date", () => {
  assert.equal(monthOf("2026-11-05"), "2026-11");
});

test("a side is done once it reaches the installment, partial below it", () => {
  assert.equal(sideState(0, 100_00), "none");
  assert.equal(sideState(40_00, 100_00), "partial");
  assert.equal(sideState(100_00, 100_00), "done");
  assert.equal(sideState(1, null), "done");
});

const liability = "11111111-1111-4111-8111-111111111111";
const bank = "22222222-2222-4222-8222-222222222222";
const setUp = {
  liabilityAccountId: liability,
  personName: "  Persona Uno ",
  receivableAccountId: "",
  amount: "1.200.000",
  openedOn: "2026-11-01",
  installmentAmount: "150.000",
  dueDay: "15",
};

test("the set-up form reads its amounts into integer cents and trims the name", () => {
  const parsed = setUpThirdPartyCreditSchema.parse(setUp);
  assert.equal(parsed.personName, "Persona Uno");
  assert.equal(parsed.receivableAccountId, null);
  assert.equal(parsed.openingCents, 1_200_000_00);
  assert.equal(parsed.installmentCents, 150_000_00);
  assert.equal(parsed.dueDay, 15);
});

test("the installment and the due day are optional", () => {
  const parsed = setUpThirdPartyCreditSchema.parse({ ...setUp, installmentAmount: "", dueDay: "" });
  assert.equal(parsed.installmentCents, null);
  assert.equal(parsed.dueDay, null);
});

test("a blank name, a day past the 31st and a zero installment are refused with a key", () => {
  for (const [patch, key] of [
    [{ personName: " " }, "thirdPartyCredit.errors.nameRequired"],
    [{ dueDay: "32" }, "thirdPartyCredit.errors.dueDayInvalid"],
    [{ installmentAmount: "0" }, "thirdPartyCredit.errors.installmentInvalid"],
  ] as const) {
    const verdict = setUpThirdPartyCreditSchema.safeParse({ ...setUp, ...patch });
    assert.equal(verdict.success, false);
    assert.equal(verdict.error?.issues[0].message, key);
  }
});

test("an existing receivable needs no opening amount", () => {
  const parsed = setUpThirdPartyCreditSchema.parse({ ...setUp, receivableAccountId: bank, amount: "" });
  assert.equal(parsed.receivableAccountId, bank);
  assert.equal(parsed.openingCents, 0);
});

test("a new receivable opens at a figure that reads", () => {
  assert.equal(setUpThirdPartyCreditSchema.safeParse({ ...setUp, amount: "" }).success, false);
  assert.equal(setUpThirdPartyCreditSchema.safeParse({ ...setUp, amount: "abc" }).success, false);
  assert.equal(setUpThirdPartyCreditSchema.safeParse({ ...setUp, amount: "0" }).success, true);
});

test("the payment form needs a positive amount, a bank and a day that is not in the future", () => {
  const ok = { liabilityAccountId: liability, toAccountId: bank, amount: "150.000", occurredAt: "2026-11-05" };
  assert.equal(recordThirdPartyPaymentSchema.safeParse(ok).success, true);
  assert.equal(recordThirdPartyPaymentSchema.safeParse({ ...ok, amount: "0" }).success, false);
  assert.equal(recordThirdPartyPaymentSchema.safeParse({ ...ok, toAccountId: "" }).success, false);
  assert.equal(recordThirdPartyPaymentSchema.safeParse({ ...ok, occurredAt: "2999-01-01" }).success, false);
});
