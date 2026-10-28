import assert from "node:assert/strict";
import test from "node:test";

import { monthSteps, parseMonthParam } from "./month-param";

const TODAY = "2026-10-22";
const FIRST = "2026-07";
const LAST = "2027-03";

test("absent and this month read as this month", () => {
  assert.deepEqual(parseMonthParam(undefined, TODAY, FIRST, LAST), { kind: "this" });
  assert.deepEqual(parseMonthParam("2026-10", TODAY, FIRST, LAST), { kind: "this" });
});

test("next month, and the limit itself, are coming", () => {
  assert.deepEqual(parseMonthParam("2026-11", TODAY, FIRST, LAST), { kind: "coming", month: "2026-11" });
  assert.deepEqual(parseMonthParam("2027-03", TODAY, FIRST, LAST), { kind: "coming", month: "2027-03" });
});

test("a month after the first goal, and the first one itself, are past", () => {
  assert.deepEqual(parseMonthParam("2026-09", TODAY, FIRST, LAST), { kind: "past", month: "2026-09" });
  assert.deepEqual(parseMonthParam("2026-07", TODAY, FIRST, LAST), { kind: "past", month: "2026-07" });
});

test("before the first goal lands on the first, past the limit on the last (RP-142)", () => {
  assert.deepEqual(parseMonthParam("2026-06", TODAY, FIRST, LAST), { kind: "redirect", to: FIRST });
  assert.deepEqual(parseMonthParam("2027-04", TODAY, FIRST, LAST), { kind: "redirect", to: LAST });
});

test("with no goal opened no past month exists", () => {
  assert.deepEqual(parseMonthParam("2026-09", TODAY, null, "2026-10"), { kind: "redirect", to: null });
});

test("a malformed value, a false month, a full date and an array redirect", () => {
  for (const raw of ["", "abc", "2026-13", "2026-00", "2026-9", "2026-10-01", ["2026-09"], ["a", "b"]]) {
    assert.deepEqual(parseMonthParam(raw, TODAY, FIRST, LAST), { kind: "redirect", to: null }, JSON.stringify(raw));
  }
});

test("a year boundary steps both ways", () => {
  assert.deepEqual(parseMonthParam("2026-12", "2027-01-05", "2026-11", "2027-02"), { kind: "past", month: "2026-12" });
  assert.deepEqual(parseMonthParam("2027-01", "2026-12-31", "2026-11", "2027-02"), { kind: "coming", month: "2027-01" });
});

test("monthSteps: no ‹ on the first goal's month, no › on the limit, across a year both ways", () => {
  assert.deepEqual(monthSteps({ month: "2026-10", firstMonth: "2026-10", lastMonth: "2027-01" }), { prev: null, next: "2026-11" });
  assert.deepEqual(monthSteps({ month: "2027-01", firstMonth: "2026-10", lastMonth: "2027-01" }), { prev: "2026-12", next: null });
  assert.deepEqual(monthSteps({ month: "2026-11", firstMonth: null, lastMonth: "2026-11" }), { prev: null, next: null });
});
