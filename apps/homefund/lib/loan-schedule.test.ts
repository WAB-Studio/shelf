import assert from "node:assert/strict";
import { test } from "node:test";

import { ActionError } from "./errors";
import { digest, median, readSchedule, uncoveredRows, usualPayment, type ScheduleRow } from "./loan-schedule";
import { parseLoanSchedule } from "./validation/loan-schedule";

// A made-up loan: 2.400.000 pesos over 12 months at 1,8 % a month, level capital-plus-interest and an insurance on
// the balance that shrinks, plus a closing fee that makes the last cuota the largest. Cents, as the ledger keeps them.
const PRINCIPAL = 240_000_000;
const MONTHLY = 0.018;
const COUNT = 12;
const CLOSING_FEE = 2_500_000;

function synthetic(): ScheduleRow[] {
  const level = Math.round((PRINCIPAL * MONTHLY) / (1 - (1 + MONTHLY) ** -COUNT));
  const rows: ScheduleRow[] = [];
  let remaining = PRINCIPAL;
  for (let number = 1; number <= COUNT; number++) {
    const interestCents = Math.round(remaining * MONTHLY);
    const principalCents = number === COUNT ? remaining : level - interestCents;
    const insuranceCents = Math.round(remaining * 0.0004) + (number === COUNT ? CLOSING_FEE : 0);
    remaining -= principalCents;
    const month = ((10 + number) % 12) + 1;
    const year = 2026 + Math.floor((10 + number) / 12);
    rows.push({
      number,
      dueOn: `${year}-${String(month).padStart(2, "0")}-05`,
      principalCents,
      interestCents,
      insuranceCents,
      totalCents: principalCents + interestCents + insuranceCents,
      remainingCents: remaining,
    });
  }
  return rows;
}

const rows = synthetic();
const usual = median(rows.map((row) => row.totalCents));
// A payer who sends a fixed round figure a little under the first cuota.
const FIXED = Math.floor(rows[0].totalCents / 1000) * 1000;

test("the synthetic loan is the shape the feature is for: a cuota that slips and a larger last one", () => {
  assert.ok(rows[0].totalCents > rows[COUNT - 2].totalCents);
  assert.ok(rows[COUNT - 1].totalCents > rows[0].totalCents * 1.05);
  assert.equal(rows[COUNT - 1].remainingCents, 0);
});

test("nothing paid: the next cuota is the first, every one remains and the end is the last day", () => {
  const summary = readSchedule(rows, [], "2026-12-01");
  assert.ok(summary);
  assert.equal(summary.next?.number, 1);
  assert.equal(summary.remainingCount, COUNT);
  assert.equal(summary.paidCount, 0);
  assert.equal(summary.endsOn, "2027-11-05");
  assert.equal(
    summary.remainingTotalCents,
    rows.reduce((sum, row) => sum + row.totalCents, 0),
  );
  assert.equal(summary.usualCents, usual);
});

test("only the cuota more than 5 % from the usual one is flagged, and a paid one is not", () => {
  const summary = readSchedule(rows, [], "2026-12-01");
  assert.deepEqual(
    summary?.differing.map((row) => row.number),
    [COUNT],
  );
  const paidLast = readSchedule(rows, [{ occurredOn: "2027-11-05", amountCents: rows[COUNT - 1].totalCents }], "2027-11-06");
  assert.deepEqual(paidLast?.differing, []);
});

test("a payment within 15 days of a due day pays that row, in full or short by a rounding", () => {
  const summary = readSchedule(
    rows,
    [
      { occurredOn: "2026-12-05", amountCents: rows[0].totalCents },
      { occurredOn: "2027-01-14", amountCents: FIXED },
    ],
    "2027-01-20",
  );
  assert.equal(summary?.rows[0].state, "paid");
  assert.equal(summary?.rows[1].state, "paid");
  assert.equal(summary?.rows[2].state, "pending");
  assert.equal(summary?.next?.number, 3);
  assert.equal(summary?.paidCount, 2);
});

test("a payment nearer a later row than an earlier one belongs to the later", () => {
  const summary = readSchedule(rows, [{ occurredOn: "2027-01-02", amountCents: rows[1].totalCents }], "2027-01-03");
  assert.equal(summary?.rows[0].state, "pending");
  assert.equal(summary?.rows[1].state, "paid");
});

test("a payment far from every row pays none", () => {
  const summary = readSchedule(rows, [{ occurredOn: "2026-10-01", amountCents: rows[0].totalCents }], "2026-12-01");
  assert.equal(summary?.paidCount, 0);
  const late = readSchedule(rows, [{ occurredOn: "2026-12-21", amountCents: rows[0].totalCents }], "2026-12-22");
  assert.equal(late?.rows[0].state, "pending");
});

test("half a cuota is partial: the row stays next, overdue past its day, and only the rest remains", () => {
  const half = Math.floor(rows[0].totalCents / 2);
  const summary = readSchedule(rows, [{ occurredOn: "2026-12-05", amountCents: half }], "2026-12-10");
  assert.equal(summary?.rows[0].state, "partial");
  assert.equal(summary?.rows[0].overdue, true);
  assert.equal(summary?.rows[1].overdue, false);
  assert.equal(summary?.next?.number, 1);
  assert.equal(summary?.remainingCount, COUNT);
  assert.equal(
    summary?.remainingTotalCents,
    rows.reduce((sum, row) => sum + row.totalCents, 0) - half,
  );
});

test("a paid loan has no next cuota and nothing remaining", () => {
  const payments = rows.map((row) => ({ occurredOn: row.dueOn, amountCents: row.totalCents }));
  const summary = readSchedule(rows, payments, "2027-12-01");
  assert.equal(summary?.next, null);
  assert.equal(summary?.remainingCount, 0);
  assert.equal(summary?.remainingTotalCents, 0);
});

test("a loan with no schedule reads as none", () => {
  assert.equal(readSchedule([], [], "2026-12-01"), null);
});

test("the digest keeps the figures and drops the rows", () => {
  const summary = readSchedule(rows, [], "2026-12-01");
  assert.ok(summary);
  const short = digest(summary);
  assert.equal("rows" in short, false);
  assert.equal(short.remainingCount, COUNT);
});

test("the usual payment is the middle of the last six months in which something arrived", () => {
  assert.equal(usualPayment([0, 100, 0, 300, 200]), 200);
  assert.equal(usualPayment([0, 0]), null);
  assert.equal(usualPayment([10, 10, 10, 10, 10, 10, 9_999, 9_999, 9_999]), 10);
});

test("a fixed payment covers every cuota but the large last one", () => {
  const summary = readSchedule(rows, [], "2026-12-01");
  assert.ok(summary);
  const short = uncoveredRows(summary, FIXED);
  assert.deepEqual(
    short.map((row) => row.number),
    [COUNT],
  );
  assert.equal(short[0].shortCents, rows[COUNT - 1].totalCents - FIXED);
  assert.deepEqual(uncoveredRows(summary, null), []);
});

test("a cuota already paid is never short", () => {
  const paid = readSchedule(rows, [{ occurredOn: "2027-11-05", amountCents: rows[COUNT - 1].totalCents }], "2027-11-06");
  assert.ok(paid);
  assert.deepEqual(uncoveredRows(paid, FIXED), []);
});

const payload = (change: (row: Record<string, number | string>[]) => void = () => {}) => {
  const body = rows.map((row) => ({
    dueOn: row.dueOn,
    principalCents: row.principalCents,
    interestCents: row.interestCents,
    insuranceCents: row.insuranceCents,
    totalCents: row.totalCents,
    remainingCents: row.remainingCents,
  }));
  change(body);
  return { accountId: "0f8fad5b-d9cb-469f-a165-70867728950e", rows: body };
};

function refusal(data: unknown): { key: string; row?: string } {
  try {
    parseLoanSchedule(data);
  } catch (error) {
    assert.ok(error instanceof ActionError);
    return { key: error.messageKey, row: error.values?.row };
  }
  assert.fail("the schedule was accepted");
}

test("the bank's rows are accepted and numbered from 1", () => {
  const read = parseLoanSchedule(payload());
  assert.equal(read.rows.length, COUNT);
  assert.deepEqual(
    read.rows.map((row) => row.number),
    rows.map((row) => row.number),
  );
});

test("a cuota left out is the sum of its parts", () => {
  const read = parseLoanSchedule(payload((body) => delete body[3].totalCents));
  assert.equal(read.rows[3].totalCents, rows[3].totalCents);
});

test("a total that is not the sum names its row", () => {
  assert.deepEqual(refusal(payload((body) => (body[4].totalCents = (body[4].totalCents as number) + 1))), {
    key: "loanSchedule.errors.totalMismatch",
    row: "5",
  });
});

test("a capital that does not fall by what the row repays names its row", () => {
  assert.deepEqual(refusal(payload((body) => (body[6].remainingCents = (body[6].remainingCents as number) + 100))), {
    key: "loanSchedule.errors.chainBroken",
    row: "7",
  });
});

test("a day that does not follow the one before names its row", () => {
  assert.deepEqual(refusal(payload((body) => (body[2].dueOn = body[1].dueOn))), {
    key: "loanSchedule.errors.datesNotIncreasing",
    row: "3",
  });
});

test("a schedule that leaves capital owed is refused at its last row", () => {
  const left = payload((body) => {
    const last = body[COUNT - 1];
    last.principalCents = (last.principalCents as number) - 100;
    last.totalCents = (last.totalCents as number) - 100;
    last.remainingCents = 100;
  });
  assert.deepEqual(refusal(left), {
    key: "loanSchedule.errors.notPaidOff",
    row: String(COUNT),
  });
});

test("a fraction of a cent, a negative part and no rows are refused", () => {
  assert.equal(refusal(payload((body) => (body[0].interestCents = 10.5))).key, "loanSchedule.errors.amountInvalid");
  assert.equal(refusal(payload((body) => (body[0].insuranceCents = -1))).key, "loanSchedule.errors.amountInvalid");
  assert.equal(refusal({ accountId: "0f8fad5b-d9cb-469f-a165-70867728950e", rows: [] }).key, "loanSchedule.errors.rowsRequired");
  assert.equal(refusal(payload((body) => (body[0].dueOn = "2026-02-31"))).key, "loanSchedule.errors.dateInvalid");
});
