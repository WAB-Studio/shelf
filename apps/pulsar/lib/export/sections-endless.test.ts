import assert from "node:assert/strict";
import test from "node:test";

import type { GoalReport } from "./report";
import { printsOnPaper } from "./sections";

type Month = GoalReport["months"][number];

const month = (patch: Partial<Month>): Month => ({
  month: "2026-12-01",
  planned: null,
  reached: 0,
  current: false,
  past: false,
  carried: null,
  endless: true,
  ...patch,
});

test("a coming endless month with no amount and no tasks does not print", () => {
  assert.equal(printsOnPaper(month({}), "páginas"), false);
  assert.equal(printsOnPaper(month({}), null), false);
});

test("a coming endless month with an amount prints", () => {
  assert.equal(printsOnPaper(month({ planned: 40 }), "páginas"), true);
  assert.equal(printsOnPaper(month({ planned: 0 }), "páginas"), true);
});

test("a past or current endless month prints", () => {
  assert.equal(printsOnPaper(month({ past: true }), "páginas"), true);
  assert.equal(printsOnPaper(month({ current: true }), "páginas"), true);
});
