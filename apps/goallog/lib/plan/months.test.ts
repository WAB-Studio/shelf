import assert from "node:assert/strict";
import test from "node:test";

import type { DeclaredFact, EvidenceDay } from "@/lib/day/types";
import {
  monthLine,
  monthOf,
  previousMonth,
  monthRows,
  monthsOfSpan,
  partOf,
  plannedOf,
  reachedByMonth,
  settledMonths,
  toDate,
} from "./months";
import { weekPlanned } from "./week-planned";

function fact(day: string, quantity: number, unit: string): DeclaredFact {
  return { commitmentId: "c", day, writtenAt: `${day}T12:00:00Z`, quantity, unit, note: null };
}

function evidenceDay(day: string, quantity: number, unit: string): EvidenceDay {
  return { day, quantity, unit, labelKey: "sources.readingLookups" };
}

const OCT = "2026-10-01";
const budget = { month: OCT, amount: 720 };
// A goal that fills September to November whole, for the rules that are not RP-74's.
const span = { openedOn: "2026-09-01", horizon: "2026-12-01" };

test("previousMonth: steps back within a year and across January", () => {
  assert.equal(previousMonth("2026-10-01"), "2026-09-01");
  assert.equal(previousMonth("2027-01-01"), "2026-12-01");
});

test("monthOf: any day reads as the first of its month", () => {
  assert.equal(monthOf("2026-10-31"), "2026-10-01");
  assert.equal(monthOf("2026-11-01"), "2026-11-01");
});

test("monthsOfSpan: a span opened on the 31st of January lists February", () => {
  assert.deepEqual(monthsOfSpan("2026-01-31", "2026-03-01"), ["2026-01-01", "2026-02-01"]);
});

test("monthsOfSpan: ends at the month of the horizon's day before, not the horizon's own", () => {
  assert.deepEqual(monthsOfSpan("2026-09-29", "2026-11-01"), ["2026-09-01", "2026-10-01"]);
  assert.deepEqual(monthsOfSpan("2026-09-29", "2026-11-02"), [
    "2026-09-01",
    "2026-10-01",
    "2026-11-01",
  ]);
});

test("monthsOfSpan: crosses a year", () => {
  assert.deepEqual(monthsOfSpan("2026-12-15", "2027-02-10"), [
    "2026-12-01",
    "2027-01-01",
    "2027-02-01",
  ]);
});

test("reachedByMonth: the 31st of a 31-day month and the 1st of the next fall in two months", () => {
  const reached = reachedByMonth({
    unit: "min",
    facts: [fact("2026-10-31", 10, "min"), fact("2026-11-01", 7, "min")],
    evidence: [],
  });
  assert.equal(reached.get("2026-10-01"), 10);
  assert.equal(reached.get("2026-11-01"), 7);
});

test("reachedByMonth: a fact in min does not feed a goal in minutos", () => {
  const reached = reachedByMonth({
    unit: "minutos",
    facts: [fact("2026-10-05", 10, "min"), fact("2026-10-06", 4, "minutos")],
    evidence: [evidenceDay("2026-10-07", 100, "min"), evidenceDay("2026-10-08", 3, "minutos")],
  });
  assert.equal(reached.get(OCT), 7);
});

test("reachedByMonth: facts and evidence add up; a null unit reads empty", () => {
  const facts = [fact("2026-10-05", 10, "min")];
  const evidence = [evidenceDay("2026-10-06", 5, "min")];
  assert.equal(reachedByMonth({ unit: "min", facts, evidence }).get(OCT), 15);
  assert.equal(reachedByMonth({ unit: null, facts, evidence }).size, 0);
});

test("monthLine: 431 of 720 on the 20th is under pace, 432 is not", () => {
  const line = (reached: number) =>
    monthLine({ month: OCT, today: "2026-10-20", budget, reached, ...span });
  assert.equal(line(431).underPace, true);
  assert.equal(line(432).underPace, false);
  assert.equal(line(431).planned, 720);
});

test("monthLine: the 19th is never under pace", () => {
  assert.equal(monthLine({ month: OCT, today: "2026-10-19", budget, reached: 0, ...span }).underPace, false);
});

test("monthLine: a past or future month is never under pace", () => {
  assert.equal(
    monthLine({ month: "2026-09-01", today: "2026-10-25", budget: { month: "2026-09-01", amount: 720 }, reached: 0, ...span }).underPace,
    false,
  );
  assert.equal(
    monthLine({ month: "2026-11-01", today: "2026-10-25", budget: { month: "2026-11-01", amount: 720 }, reached: 0, ...span }).underPace,
    false,
  );
});

test("monthLine: a zero amount or no amount is never under pace", () => {
  const today = "2026-10-25";
  const zero = monthLine({ month: OCT, today, budget: { month: OCT, amount: 0 }, reached: 0, ...span });
  assert.equal(zero.underPace, false);
  assert.equal(zero.planned, 0);
  const none = monthLine({ month: OCT, today, budget: null, reached: 0, ...span });
  assert.equal(none.underPace, false);
  assert.equal(none.planned, null);
});

test("monthRows: one row per month of the span, a month with nothing included, flags set", () => {
  const rows = monthRows({
    openedOn: "2026-09-10",
    horizon: "2026-12-01",
    today: "2026-10-22",
    budgets: [{ month: OCT, amount: 720 }],
    reached: new Map([["2026-09-01", 50]]),
  });
  assert.deepEqual(rows, [
    { month: "2026-09-01", planned: null, reached: 50, current: false, past: true },
    { month: OCT, planned: 720, reached: 0, current: true, past: false },
    { month: "2026-11-01", planned: null, reached: 0, current: false, past: false },
  ]);
});

test("toDate: sums through the current month, a month without amount adds 0 planned", () => {
  const rows = monthRows({
    openedOn: "2026-09-10",
    horizon: "2026-12-01",
    today: "2026-10-22",
    budgets: [{ month: OCT, amount: 720 }],
    reached: new Map([
      ["2026-09-01", 50],
      [OCT, 100],
      ["2026-11-01", 999],
    ]),
  });
  assert.deepEqual(toDate(rows), { planned: 720, reached: 150 });
});

test("monthRows: a month with no budget reads the rhythm; a budget wins, 0 included; no rhythm reads as before", () => {
  const rows = (budgets: { month: string; amount: number }[], rhythm?: number | null) =>
    monthRows({
      openedOn: "2026-09-10",
      horizon: "2026-12-01",
      today: "2026-10-22",
      budgets,
      reached: new Map(),
      rhythm,
    }).map((row) => row.planned);
  // September opens on the 10th: 21 of its 30 days plan 210 of 300 (RP-74).
  assert.deepEqual(rows([{ month: OCT, amount: 720 }], 300), [210, 720, 300]);
  assert.deepEqual(rows([{ month: OCT, amount: 0 }], 300), [210, 0, 300]);
  assert.deepEqual(rows([{ month: OCT, amount: 720 }]), [null, 720, null]);
  assert.deepEqual(rows([], null), [null, null, null]);
});

test("monthLine: no budget reads the rhythm; a budget wins, 0 included; no rhythm reads as before", () => {
  const line = (budget: { month: string; amount: number } | null, rhythm?: number | null) =>
    monthLine({ month: OCT, today: "2026-10-10", budget, reached: 0, rhythm, ...span }).planned;
  assert.equal(line(null, 300), 300);
  assert.equal(line({ month: OCT, amount: 720 }, 300), 720);
  assert.equal(line({ month: OCT, amount: 0 }, 300), 0);
  assert.equal(line(null), null);
  assert.equal(line(null, null), null);
});

test("monthLine: the pace rule fires on the rhythm from the 20th", () => {
  const line = (today: string, reached: number) =>
    monthLine({ month: OCT, today, budget: null, reached, rhythm: 720, ...span });
  assert.equal(line("2026-10-20", 431).underPace, true);
  assert.equal(line("2026-10-20", 432).underPace, false);
  assert.equal(line("2026-10-19", 0).underPace, false);
  assert.equal(monthLine({ month: OCT, today: "2026-10-25", budget: null, reached: 0, rhythm: 0, ...span }).underPace, false);
});

// «Reto de lectura»: 16 September to 7 October 2026, 600 min a month.
const reto = { openedOn: "2026-09-16", horizon: "2026-10-08", rhythm: 600, budgets: [] };

test("plannedOf: a first month the goal opens mid-way plans its days' share", () => {
  assert.equal(plannedOf("2026-09-01", reto), 300);
});

test("plannedOf: a last month the goal leaves mid-way plans its share, rounded down", () => {
  assert.equal(plannedOf(OCT, reto), 135);
  // 600 × 16 / 31 is 309.68: down, not to the nearest.
  assert.equal(plannedOf(OCT, { openedOn: "2026-10-16", horizon: "2027-01-01", rhythm: 600, budgets: [] }), 309);
});

test("plannedOf: a goal that opens and closes inside one month counts both edges", () => {
  assert.equal(plannedOf(OCT, { openedOn: "2026-10-05", horizon: "2026-10-21", rhythm: 620, budgets: [] }), 320);
});

test("plannedOf: a month the goal fills plans the whole rhythm", () => {
  const goal = { openedOn: "2026-09-01", horizon: "2027-06-01", rhythm: 480, budgets: [] };
  assert.equal(plannedOf("2026-11-01", goal), 480);
  assert.equal(plannedOf("2027-05-01", goal), 480);
});

test("plannedOf: a horizon on the 1st leaves the month before whole and its own month out", () => {
  const goal = { openedOn: "2026-09-01", horizon: "2026-12-01", rhythm: 480, budgets: [] };
  assert.equal(plannedOf("2026-11-01", goal), 480);
  assert.equal(plannedOf("2026-12-01", goal), 0);
  assert.deepEqual(
    monthRows({ ...goal, today: "2026-11-15", reached: new Map() }).map((row) => [row.month, row.planned]),
    [
      ["2026-09-01", 480],
      ["2026-10-01", 480],
      ["2026-11-01", 480],
    ],
  );
});

test("plannedOf: a month with its own amount takes it whole", () => {
  const bici = { openedOn: "2026-10-10", horizon: "2027-01-01", rhythm: 300, budgets: [{ month: OCT, amount: 100 }] };
  assert.equal(plannedOf(OCT, bici), 100);
});

test("plannedOf: no rhythm and no amount reads null", () => {
  assert.equal(plannedOf(OCT, { openedOn: "2026-10-10", horizon: "2027-01-01", rhythm: null, budgets: [] }), null);
});

test("monthRows and monthLine plan Reto's shares; to date sums them", () => {
  const rows = monthRows({ ...reto, today: "2026-10-07", reached: new Map() });
  assert.deepEqual(rows.map((row) => row.planned), [300, 135]);
  assert.equal(toDate(rows).planned, 435);
  assert.equal(
    monthLine({ month: OCT, today: "2026-10-07", budget: null, reached: 0, rhythm: 600, openedOn: reto.openedOn, horizon: reto.horizon }).planned,
    135,
  );
});

test("monthLine: the pace rule reads the share", () => {
  // 5 to 20 October at 620 plans 320: 192 is 60 % exactly, 191 is under it.
  const line = (reached: number) =>
    monthLine({ month: OCT, today: "2026-10-20", budget: null, reached, rhythm: 620, openedOn: "2026-10-05", horizon: "2026-10-21" });
  assert.equal(line(191).underPace, true);
  assert.equal(line(192).underPace, false);
});

test("weekPlanned: Reto's week of 5 to 7 October keeps its share of the whole month", () => {
  assert.equal(
    weekPlanned({ weekStart: "2026-10-05", weekEnd: "2026-10-11", budgets: [], openedOn: reto.openedOn, horizon: reto.horizon, rhythm: 600 }),
    58,
  );
});

test("settledMonths: an ended goal has no month «en curso»; all read as closed", () => {
  const rows = [
    { month: "2026-09-01", current: false, past: true },
    { month: "2026-10-01", current: true, past: false },
  ];
  assert.deepEqual(settledMonths(rows, true), [
    { month: "2026-09-01", current: false, past: true },
    { month: "2026-10-01", current: false, past: true },
  ]);
});

test("settledMonths: a goal still running keeps its rows as they are", () => {
  const rows = [
    { month: "2026-09-01", current: false, past: true },
    { month: "2026-10-01", current: true, past: false },
  ];
  assert.deepEqual(settledMonths(rows, false), rows);
});

test("partOf: names the days a first, a last and a one-month goal fill; a whole month none", () => {
  const base = { budgets: [], rhythm: 600 };
  const first = { ...base, openedOn: "2026-09-16", horizon: "2026-10-08" };
  assert.deepEqual(partOf("2026-09-01", first), { kind: "from", from: 16, to: 30, share: 300, rhythm: 600 });
  assert.deepEqual(partOf("2026-10-01", first), { kind: "to", from: 1, to: 7, share: 135, rhythm: 600 });
  const both = { ...base, openedOn: "2026-10-07", horizon: "2026-10-21" };
  assert.deepEqual(partOf("2026-10-01", both), { kind: "between", from: 7, to: 20, share: 270, rhythm: 600 });
  assert.equal(partOf("2026-10-01", { ...base, openedOn: "2026-10-01", horizon: "2026-12-01" }), null);
  assert.equal(partOf("2026-10-01", { ...first, budgets: [{ month: "2026-10-01", amount: 60 }] }), null);
  assert.equal(partOf("2026-10-01", { ...first, rhythm: null }), null);
});
