import assert from "node:assert/strict";
import { test } from "node:test";

import { accruedInterestCents, splitInstalment } from "./loan-instalment";

test("a month of interest at 16,5 % E.A. on 2 million pesos is cut down to the cent", () => {
  // (1.165)^(30/365) - 1 = 1.2765 %: owed times that, never rounded up (2.553.000 cents).
  const interest = accruedInterestCents(2_000_000_00, "0.165", 30);
  assert.ok(Number.isInteger(interest));
  assert.ok(interest > 2_500_000 && interest < 2_600_000, String(interest));
});

test("no days, no rate or nothing owed accrues nothing", () => {
  assert.equal(accruedInterestCents(1_000_00, "0.2", 0), 0);
  assert.equal(accruedInterestCents(1_000_00, "0", 30), 0);
  assert.equal(accruedInterestCents(0, "0.2", 30), 0);
});

test("a schedule row wins over the rate and its insurance counts with its interest", () => {
  const split = splitInstalment({
    amountCents: 780_000_00,
    owedCents: 10_000_000_00,
    annualRate: "0.165",
    days: 30,
    row: { interestCents: 320_000_00, insuranceCents: 10_000_00 },
  });
  assert.deepEqual(split, { interestCents: 330_000_00, capitalCents: 450_000_00, basis: "schedule" });
});

test("without a schedule the rate splits it and the interest and capital add to the payment", () => {
  const split = splitInstalment({ amountCents: 780_000_00, owedCents: 10_000_000_00, annualRate: "0.165", days: 30, row: null });
  assert.equal(split.basis, "rate");
  assert.equal(split.interestCents + split.capitalCents, 780_000_00);
  assert.ok(split.interestCents > 0 && split.capitalCents > 0);
});

test("the interest never exceeds what was paid, and no rate puts it all on the capital", () => {
  assert.deepEqual(
    splitInstalment({ amountCents: 1_000_00, owedCents: 10_000_000_00, annualRate: "0.3", days: 30, row: null }),
    { interestCents: 1_000_00, capitalCents: 0, basis: "rate" },
  );
  assert.deepEqual(
    splitInstalment({ amountCents: 500_00, owedCents: 9_000_00, annualRate: null, days: 30, row: null }),
    { interestCents: 0, capitalCents: 500_00, basis: "none" },
  );
});

test("a part-payment of a cuota takes its interest first, and the rest of the cuota only the interest still unpaid", () => {
  const row = { interestCents: 105_582_00, insuranceCents: 0 };
  const first = splitInstalment({ amountCents: 200_000_00, owedCents: 5_000_000_00, annualRate: null, days: 30, row });
  assert.deepEqual(first, { interestCents: 105_582_00, capitalCents: 94_418_00, basis: "schedule" });

  const small = splitInstalment({ amountCents: 50_000_00, owedCents: 5_000_000_00, annualRate: null, days: 30, row });
  assert.deepEqual(small, { interestCents: 50_000_00, capitalCents: 0, basis: "schedule" });
  const rest = splitInstalment({
    amountCents: 136_793_00,
    owedCents: 5_000_000_00,
    annualRate: null,
    days: 30,
    row: { ...row, paidInterestCents: 50_000_00 },
  });
  assert.deepEqual(rest, { interestCents: 55_582_00, capitalCents: 81_211_00, basis: "schedule" });
});

test("a payment of the whole cuota takes the row's own interest and brings the capital down by the row's capital", () => {
  const split = splitInstalment({
    amountCents: 336_793_00,
    owedCents: 4_768_789_00,
    annualRate: "0.2",
    days: 31,
    row: { interestCents: 100_700_00, insuranceCents: 0 },
  });
  assert.deepEqual(split, { interestCents: 100_700_00, capitalCents: 236_093_00, basis: "schedule" });
});
