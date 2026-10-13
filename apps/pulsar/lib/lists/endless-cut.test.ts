import assert from "node:assert/strict";
import test from "node:test";

import { endlessCut } from "./endless-cut";
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
  assert.equal(cut.shown.length, 12);
  assert.equal(months(cut.shown)[0], "2025-11");
  assert.equal(months(cut.shown)[11], "2026-10");
  assert.equal(cut.shown[11].current, true);
  assert.equal(cut.hidden, 12);
  assert.deepEqual(cut.line, { planned: 40 });
  assert.equal(cut.shown.some((row) => !row.past && !row.current), false);
  assert.deepEqual(cut.empty, []);
});

test("a month with its own amount is a row between the current month and the line", () => {
  const rows = withPlanned(rowsFor("2024-11-05"), { "2026-12": 60 });
  const cut = endlessCut(rows, { all: false, rhythm: 40 });
  assert.deepEqual(months(cut.shown).slice(-2), ["2026-10", "2026-12"]);
  assert.equal(cut.shown.length, 13);
  assert.deepEqual(cut.line, { planned: 40 });
});

test("a hand-set amount equal to the rhythm folds, it is not a row", () => {
  const rows = withPlanned(rowsFor("2024-11-05"), { "2026-12": 40 });
  const cut = endlessCut(rows, { all: false, rhythm: 40 });
  assert.equal(cut.shown.length, 12);
  assert.deepEqual(cut.line, { planned: 40 });
});

test("with no rhythm, only hand-set months show; the rest are empty and there is no line", () => {
  const rows = withPlanned(rowsFor("2024-11-05", null), { "2026-12": 60 });
  const cut = endlessCut(rows, { all: false, rhythm: null });
  assert.equal(cut.shown.length, 13);
  assert.equal(months(cut.shown)[12], "2026-12");
  assert.equal(cut.line, null);
  assert.equal(cut.empty.length, 10);
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
  assert.deepEqual(months(cut.shown), ["2026-08", "2026-09", "2026-10"]);
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
