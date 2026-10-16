import assert from "node:assert/strict";
import test from "node:test";

import { endlessCut, foldsMonths } from "./endless-cut";
import { monthRows } from "@/lib/plan/months";

type Row = ReturnType<typeof monthRows>[number];

function rowsFor(openedOn: string, rhythm: number | null = 40) {
  return monthRows({ openedOn, horizon: null, today: "2026-10-13", budgets: [], reached: new Map(), rhythm });
}

const months = (rows: Row[]) => rows.map((row) => row.month.slice(0, 7));
const withPlanned = (rows: Row[], patch: Record<string, number | null>) =>
  rows.map((row) => (row.month.slice(0, 7) in patch ? { ...row, planned: patch[row.month.slice(0, 7)] } : row));

test("E1: shows the last 12 through the current month, hides the older ones, folds the coming into a line", () => {
  const cut = endlessCut(rowsFor("2024-11-05"), { all: false, rhythm: 40 });
  assert.equal(cut.shown.length, 13);
  assert.equal(months(cut.shown)[0], "2025-11");
  assert.equal(months(cut.shown)[11], "2026-10");
  assert.equal(cut.shown[11].current, true);
  assert.equal(cut.hidden, 12);
  assert.deepEqual(cut.line, { planned: 40 });
  assert.deepEqual(cut.shown.filter((row) => !row.past && !row.current).map((row) => row.month.slice(0, 7)), ["2026-11"]);
  assert.deepEqual(cut.empty, []);
});

test("a month with its own amount is a row between the current month and the line", () => {
  const rows = withPlanned(rowsFor("2024-11-05"), { "2026-12": 60 });
  const cut = endlessCut(rows, { all: false, rhythm: 40 });
  assert.deepEqual(months(cut.shown).slice(-3), ["2026-10", "2026-11", "2026-12"]);
  assert.equal(cut.shown.length, 14);
  assert.deepEqual(cut.line, { planned: 40 });
});

test("a hand-set amount equal to the rhythm folds, it is not a row", () => {
  const rows = withPlanned(rowsFor("2024-11-05"), { "2026-12": 40 });
  const cut = endlessCut(rows, { all: false, rhythm: 40 });
  assert.equal(cut.shown.length, 13);
  assert.deepEqual(cut.handSet, []);
  assert.deepEqual(cut.line, { planned: 40 });
});

test("with no rhythm, only hand-set months show; the rest are empty and there is no line", () => {
  const rows = withPlanned(rowsFor("2024-11-05", null), { "2026-12": 60 });
  const cut = endlessCut(rows, { all: false, rhythm: null });
  assert.equal(cut.shown.length, 14);
  assert.equal(months(cut.shown)[13], "2026-12");
  assert.equal(cut.line, null);
  assert.equal(cut.empty.length, 9);
});

test("a rhythm with every coming month set by hand to another amount gives no line", () => {
  const patch: Record<string, number> = {};
  for (const row of rowsFor("2024-11-05")) if (!row.past && !row.current) patch[row.month.slice(0, 7)] = 7;
  const cut = endlessCut(withPlanned(rowsFor("2024-11-05"), patch), { all: false, rhythm: 40 });
  assert.equal(cut.line, null);
  assert.equal(cut.shown.length, 23);
  assert.deepEqual(cut.empty, []);
});

test("a goal opened three months ago shows 3 rows and a line", () => {
  const cut = endlessCut(rowsFor("2026-08-17"), { all: false, rhythm: 40 });
  assert.deepEqual(months(cut.shown), ["2026-08", "2026-09", "2026-10", "2026-11"]);
  assert.equal(cut.hidden, 0);
  assert.deepEqual(cut.line, { planned: 40 });
});

test("all shows every row, coming ones with and without an amount", () => {
  const rows = withPlanned(rowsFor("2024-11-05", null), { "2026-12": 60 });
  const cut = endlessCut(rows, { all: true, rhythm: null });
  assert.deepEqual(cut.shown, rows);
  assert.equal(cut.shown.length, 35);
  assert.equal(cut.hidden, 0);
  assert.equal(cut.line, null);
  assert.deepEqual(cut.empty, []);
});

test("a settled goal (every month past) has no line and nothing empty", () => {
  const rows = rowsFor("2026-08-17").map((row) => ({ ...row, past: true, current: false }));
  const cut = endlessCut(rows, { all: false, rhythm: 40 });
  assert.equal(cut.shown.length, 12);
  assert.equal(cut.hidden, 2);
  assert.equal(cut.line, null);
  assert.deepEqual(cut.empty, []);
});

const ym = (row: { month: string } | null) => row?.month.slice(0, 7);

test("E1 pieces: 12 up to the current, the next month, its own-amount month after, the line after next", () => {
  const cut = endlessCut(withPlanned(rowsFor("2024-11-05"), { "2026-12": 60 }), { all: false, rhythm: 40 });
  assert.equal(cut.upTo.length, 12);
  assert.equal(ym(cut.upTo[0]), "2025-11");
  assert.equal(cut.upTo[11].current, true);
  assert.equal(cut.hidden, 12);
  assert.equal(ym(cut.next), "2026-11");
  assert.equal(cut.next?.planned, 40);
  assert.deepEqual(cut.line, { planned: 40 });
  assert.deepEqual(cut.handSet.map(ym), ["2026-12"]);
  assert.deepEqual(cut.shown.map(ym), [...cut.upTo.map(ym), "2026-11", "2026-12"]);
});

test("E1-6: next set by hand is next only, never repeated in handSet; the line keeps the rhythm", () => {
  const cut = endlessCut(withPlanned(rowsFor("2024-11-05"), { "2026-11": 55, "2026-12": 60 }), { all: false, rhythm: 40 });
  assert.equal(ym(cut.next), "2026-11");
  assert.equal(cut.next?.planned, 55);
  assert.deepEqual(cut.handSet.map(ym), ["2026-12"]);
  assert.deepEqual(cut.line, { planned: 40 });
});

test("E1b: no rhythm, next is a row without an amount, not empty; no line", () => {
  const cut = endlessCut(rowsFor("2026-08-17", null), { all: false, rhythm: null });
  assert.equal(ym(cut.next), "2026-11");
  assert.equal(cut.next?.planned, null);
  assert.equal(cut.line, null);
  assert.equal(cut.empty.length, 10);
  assert.equal(cut.empty.some((row) => ym(row) === "2026-11"), false);
  assert.equal(ym(cut.empty[0]), "2026-12");
  assert.equal(ym(cut.empty[9]), "2027-09");
});

test("E1b with December by hand: handSet holds it and empty has 9", () => {
  const cut = endlessCut(withPlanned(rowsFor("2026-08-17", null), { "2026-12": 60 }), { all: false, rhythm: null });
  assert.deepEqual(cut.handSet.map(ym), ["2026-12"]);
  assert.equal(cut.empty.length, 9);
});

test("E1c: opened this month, one row up to, no hidden, next and the line", () => {
  const cut = endlessCut(rowsFor("2026-10-06", 33), { all: false, rhythm: 33 });
  assert.deepEqual(cut.upTo.map(ym), ["2026-10"]);
  assert.equal(cut.hidden, 0);
  assert.equal(ym(cut.next), "2026-11");
  assert.deepEqual(cut.line, { planned: 33 });
});

test("year end: the current month December has January of the next year as next", () => {
  const rows = monthRows({ openedOn: "2026-08-17", horizon: null, today: "2026-12-10", budgets: [], reached: new Map(), rhythm: 40 });
  assert.equal(ym(endlessCut(rows, { all: false, rhythm: 40 }).next), "2027-01");
});

test("no current month: no next, no line, no hand-set", () => {
  const rows = rowsFor("2026-08-17").map((row) => ({ ...row, past: true, current: false }));
  const cut = endlessCut(rows, { all: false, rhythm: 40 });
  assert.equal(cut.next, null);
  assert.equal(cut.line, null);
  assert.deepEqual(cut.handSet, []);
});

test("all: every row in order, no next, no line, no hand-set", () => {
  const rows = rowsFor("2024-11-05");
  const cut = endlessCut(rows, { all: true, rhythm: 40 });
  assert.deepEqual(cut.shown, rows);
  assert.deepEqual(cut.upTo, rows);
  assert.equal(cut.next, null);
  assert.equal(cut.line, null);
  assert.deepEqual(cut.handSet, []);
});

test("shown keeps the order of the rows within each group", () => {
  const cut = endlessCut(withPlanned(rowsFor("2024-11-05"), { "2027-03": 5, "2026-12": 60 }), { all: false, rhythm: 40 });
  assert.deepEqual(cut.handSet.map(ym), ["2026-12", "2027-03"]);
});

test("next at the rhythm is not the line: with every later month by hand, there is no line", () => {
  const patch: Record<string, number> = {};
  for (const row of rowsFor("2024-11-05")) if (!row.past && !row.current && row.month.slice(0, 7) !== "2026-11") patch[row.month.slice(0, 7)] = 7;
  const cut = endlessCut(withPlanned(rowsFor("2024-11-05"), patch), { all: false, rhythm: 40 });
  assert.equal(ym(cut.next), "2026-11");
  assert.equal(cut.next?.planned, 40);
  assert.equal(cut.line, null);
});

// Synthetic rows: `count` consecutive months from `from`, the first `past` ones closed, then one current.
function synth(from: string, count: number, pastCount: number, planned: (month: string, i: number) => number | null) {
  const [y, m] = from.split("-").map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    return { month, past: i < pastCount, current: i === pastCount, planned: planned(month, i) };
  });
}
const ids = (rows: { month: string }[]) => rows.map((row) => row.month);

test("foldsMonths: no end folds; an end folds only past 12 rows", () => {
  const rows = (n: number) => Array.from({ length: n }, () => ({}));
  assert.equal(foldsMonths(null, rows(3)), true);
  assert.equal(foldsMonths("2027-01-04", rows(12)), false);
  assert.equal(foldsMonths("2027-01-04", rows(13)), true);
  assert.equal(foldsMonths("2027-01-04", rows(27)), true);
  assert.equal(foldsMonths("2036-09-29", rows(120)), true);
  assert.equal(foldsMonths("2026-12-31", rows(4)), false);
  assert.equal(foldsMonths("2026-12-07", rows(11)), false);
});

test("e1: no current month means no next, even with months to come", () => {
  const rows = [
    ...synth("2026-08", 3, 3, () => null),
    ...synth("2026-11", 1, -1, () => 40),
    ...synth("2026-12", 1, -1, () => 60),
  ];
  const cut = endlessCut(rows, { all: false, rhythm: 40 });
  assert.equal(cut.next, null);
  assert.deepEqual(cut.line, { planned: 40 });
  assert.deepEqual(ids(cut.handSet), ["2026-12"]);
});

test("E5: a settled long goal shows its last 12, hides the rest, no next, line, hand-set or rest", () => {
  const cut = endlessCut(synth("2025-03", 20, 20, () => null), { all: false, rhythm: null });
  assert.equal(cut.upTo.length, 12);
  assert.equal(cut.hidden, 8);
  assert.equal(cut.next, null);
  assert.equal(cut.line, null);
  assert.deepEqual(cut.handSet, []);
  assert.equal(cut.rest, null);
});

test("no ends: rest is always null", () => {
  const cut = endlessCut(synth("2024-11", 27, 12, (_, i) => (i > 12 ? 40 : null)), { all: false, rhythm: 40 });
  assert.equal(cut.rest, null);
});

test("E2: an end 27 months in; the partial last month is not a hand-set row, the rest is counted", () => {
  const rows = synth("2024-11", 27, 23, (month) => (month === "2027-01" ? 3 : 40));
  const cut = endlessCut(rows, { all: false, rhythm: 40, ends: { lastDay: "2027-01-03" } });
  assert.equal(cut.upTo.length, 12);
  assert.equal(cut.upTo[0].month, "2025-11");
  assert.equal(cut.upTo[11].month, "2026-10");
  assert.equal(cut.next?.month, "2026-11");
  assert.deepEqual(cut.handSet, []);
  assert.deepEqual(cut.rest, { count: 2, lastDay: "2027-01-03" });
  assert.equal(cut.line, null);
  assert.deepEqual(cut.empty, []);
  assert.equal(cut.hidden, 12);
});

test("E2b: December by hand stays a row; the partial last month goes in the rest", () => {
  const rows = synth("2024-11", 33, 23, (month) => (month === "2026-12" ? 60 : month === "2027-07" ? 25 : 40));
  const cut = endlessCut(rows, { all: false, rhythm: 40, ends: { lastDay: "2027-07-25" } });
  assert.deepEqual(ids(cut.handSet), ["2026-12"]);
  assert.deepEqual(cut.rest, { count: 7, lastDay: "2027-07-25" });
  assert.deepEqual(ids(cut.shown).slice(-3), ["2026-10", "2026-11", "2026-12"]);
});

test("with an end and no rhythm, empty months are counted in the rest, never in empty", () => {
  const rows = synth("2026-08", 8, 2, () => null);
  const cut = endlessCut(rows, { all: false, rhythm: null, ends: { lastDay: "2027-03-31" } });
  assert.deepEqual(cut.empty, []);
  assert.equal(cut.next?.month, "2026-11");
  assert.deepEqual(cut.rest, { count: 4, lastDay: "2027-03-31" });
  assert.equal(cut.line, null);
});

test("E7: ten years; the rest does not count next", () => {
  const rows = synth("2026-10", 120, 0, () => 10);
  const cut = endlessCut(rows, { all: false, rhythm: 10, ends: { lastDay: "2036-09-28" } });
  assert.deepEqual(ids(cut.upTo), ["2026-10"]);
  assert.equal(cut.next?.month, "2026-11");
  assert.deepEqual(cut.rest, { count: 118, lastDay: "2036-09-28" });
  assert.equal(cut.hidden, 0);
});

test("E8: the last month is the current one, so no next and no rest", () => {
  const cut = endlessCut(synth("2025-09", 14, 13, () => 40), { all: false, rhythm: 40, ends: { lastDay: "2026-10-31" } });
  assert.equal(cut.next, null);
  assert.equal(cut.rest, null);
  assert.equal(cut.hidden, 2);
});

test("with an end and all: every row, no rest, no hand-set", () => {
  const rows = synth("2024-11", 27, 23, (month) => (month === "2027-01" ? 3 : 60));
  const cut = endlessCut(rows, { all: true, rhythm: 40, ends: { lastDay: "2027-01-03" } });
  assert.equal(cut.shown.length, 27);
  assert.equal(cut.rest, null);
  assert.deepEqual(cut.handSet, []);
});

const V1_ENDS = { lastDay: "2027-01-03" };
const v1Rows = (december = 40) => synth("2024-11", 27, 23, (month) => (month === "2027-01" ? 3 : month === "2026-12" ? december : 40));

test("seeAll: an end with closed months hidden and a rest", () => {
  const cut = endlessCut(v1Rows(), { all: false, rhythm: 40, ends: V1_ENDS });
  assert.equal(cut.hidden, 12);
  assert.deepEqual(cut.rest, { count: 2, lastDay: "2027-01-03" });
  assert.equal(cut.seeAll, true);
});

test("seeAll: an end with nothing closed hidden but a rest", () => {
  const cut = endlessCut(synth("2026-10", 120, 0, () => 10), { all: false, rhythm: 10, ends: { lastDay: "2036-09-28" } });
  assert.equal(cut.hidden, 0);
  assert.equal(cut.rest?.count, 118);
  assert.equal(cut.seeAll, true);
});

test("seeAll: no end with hidden closed months", () => {
  const cut = endlessCut(rowsFor("2024-11-05"), { all: false, rhythm: 40 });
  assert.equal(cut.hidden, 12);
  assert.equal(cut.seeAll, true);
});

test("seeAll: no end and nothing hidden is false", () => {
  const cut = endlessCut(rowsFor("2026-10-06"), { all: false, rhythm: 40 });
  assert.equal(cut.hidden, 0);
  assert.equal(cut.rest, null);
  assert.equal(cut.seeAll, false);
});

test("seeAll: the end is this month, closed months hidden, no rest", () => {
  const cut = endlessCut(synth("2025-09", 14, 13, () => 40), { all: false, rhythm: 40, ends: { lastDay: "2026-10-31" } });
  assert.equal(cut.rest, null);
  assert.equal(cut.hidden, 2);
  assert.equal(cut.seeAll, true);
});

test("seeAll: an ended goal with 20 months past", () => {
  const cut = endlessCut(synth("2025-03", 20, 20, () => null), { all: false, rhythm: null });
  assert.equal(cut.hidden, 8);
  assert.equal(cut.seeAll, true);
});

test("seeAll: everything in view is false", () => {
  const cut = endlessCut(synth("2025-11", 13, 11, () => 40), { all: false, rhythm: 40, ends: { lastDay: "2026-11-20" } });
  assert.equal(cut.hidden, 0);
  assert.equal(cut.rest, null);
  assert.equal(cut.seeAll, false);
});

test("seeAll: all is false", () => {
  const cut = endlessCut(v1Rows(), { all: true, rhythm: 40, ends: V1_ENDS });
  assert.equal(cut.seeAll, false);
});

test("u5: a single month beyond next and beyond the hand-set is a rest of one", () => {
  const cut = endlessCut(v1Rows(60), { all: false, rhythm: 40, ends: V1_ENDS });
  assert.deepEqual(ids(cut.handSet), ["2026-12"]);
  assert.deepEqual(cut.rest, { count: 1, lastDay: "2027-01-03" });
  assert.equal(cut.seeAll, true);
});

test("a rest of one: the last month alone after next, with no amount of its own", () => {
  const cut = endlessCut(synth("2025-11", 14, 11, () => 40), { all: false, rhythm: 40, ends: { lastDay: "2026-12-09" } });
  assert.equal(cut.next?.month, "2026-11");
  assert.deepEqual(cut.handSet, []);
  assert.deepEqual(cut.rest, { count: 1, lastDay: "2026-12-09" });
});
