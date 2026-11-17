import assert from "node:assert/strict";
import { test } from "node:test";

import { loanStanding, reconcileCredit } from "./loan-standing";

const none = { termMonths: null, installmentCents: null, paymentCount: 0 };

test("with a schedule the figure is what the unpaid cuotas add up to, not the balance", () => {
  const standing = loanStanding({
    ...none,
    balanceOwedCents: 5_000_000,
    schedule: { remainingTotalCents: 5_384_502, remainingCount: 16 },
  });
  assert.deepEqual(standing, { owedCents: 5_384_502, count: 16, source: "schedule" });
});

test("with no schedule the figure is the balance and the term counts what is left of it", () => {
  const standing = loanStanding({ ...none, balanceOwedCents: 5_000_000, schedule: null, termMonths: 18, paymentCount: 2 });
  assert.deepEqual(standing, { owedCents: 5_000_000, count: 16, source: "term" });
});

test("an instalment alone counts the cuotas the balance holds, rounded up", () => {
  const standing = loanStanding({ ...none, balanceOwedCents: 1_000_001, schedule: null, installmentCents: 250_000 });
  assert.deepEqual(standing, { owedCents: 1_000_001, count: 5, source: "instalment" });
});

test("with no schedule, term or instalment the loan names no count", () => {
  assert.deepEqual(loanStanding({ ...none, balanceOwedCents: 700, schedule: null }), {
    owedCents: 700,
    count: null,
    source: "balance",
  });
});

test("a loan that owes nothing is zero cuotas, whatever its term says", () => {
  assert.deepEqual(loanStanding({ ...none, balanceOwedCents: 0, schedule: null, termMonths: 12 }), {
    owedCents: 0,
    count: 0,
    source: "balance",
  });
});

test("the term never reads below one cuota while something is owed", () => {
  const standing = loanStanding({ ...none, balanceOwedCents: 10, schedule: null, termMonths: 3, paymentCount: 5 });
  assert.equal(standing.count, 1);
});

test("the credit and its payer agree, or one side says how far ahead it is", () => {
  assert.deepEqual(reconcileCredit(4_740_000, 4_740_000), { kind: "same", cents: 0 });
  assert.deepEqual(reconcileCredit(4_750_000, 4_740_000), { kind: "payerAhead", cents: 10_000 });
  assert.deepEqual(reconcileCredit(4_700_000, 4_740_000), { kind: "personAhead", cents: 40_000 });
});
