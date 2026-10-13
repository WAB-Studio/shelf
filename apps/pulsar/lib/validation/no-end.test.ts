import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { horizonRefusal, moveHorizonSchema } from "./horizon";
import { monthOutsideSpan } from "./budget";
import { addCommitmentSchema, createGoalSchema, phaseWithinHorizon } from "./plan";
import { setRhythmSchema } from "./rhythm";

const GOAL_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

test("createGoalSchema: a goal with only a name has no end", () => {
  assert.equal(createGoalSchema.parse({ name: "Leer" }).horizon, null);
  assert.equal(createGoalSchema.parse({ name: "Leer", horizon: null }).horizon, null);
  assert.equal(createGoalSchema.parse({ name: "Leer", horizon: "2027-01-01" }).horizon, "2027-01-01");
  assert.equal(createGoalSchema.safeParse({ name: "Leer", horizon: "nope" }).success, false);
});

test("moveHorizonSchema: a date or null", () => {
  assert.equal(moveHorizonSchema.parse({ goalId: GOAL_ID, horizon: null }).horizon, null);
  assert.equal(moveHorizonSchema.safeParse({ goalId: GOAL_ID, horizon: "x" }).success, false);
  assert.equal(moveHorizonSchema.safeParse({ goalId: GOAL_ID }).success, false);
});

test("horizonRefusal: null is no refusal", () => {
  assert.equal(horizonRefusal({ horizon: null, today: "2026-10-13", lastPhaseEndsOn: "2030-01-01" }), null);
});

test("phaseWithinHorizon: no end holds every phase", () => {
  assert.equal(phaseWithinHorizon({ startsOn: "2026-10-01", endsOn: "2090-01-01" }, null), true);
});

test("monthOutsideSpan: no end uses the endless last month", () => {
  const base = { openedOn: "2026-09-16", horizon: null, today: "2026-10-13" };
  assert.equal(monthOutsideSpan({ ...base, month: "2027-09" }), false);
  assert.equal(monthOutsideSpan({ ...base, month: "2027-10" }), true);
  assert.equal(monthOutsideSpan({ ...base, month: "2026-08" }), true);
});

const daily = { name: "Caminar", cadenceKind: "daily", satisfaction: "tap" } as const;

test("addCommitmentSchema: a loose habit has no goal", () => {
  assert.equal(addCommitmentSchema.safeParse(daily).success, true);
  assert.equal(addCommitmentSchema.safeParse({ ...daily, goalId: GOAL_ID }).success, true);
  assert.equal(addCommitmentSchema.safeParse({ ...daily, goalId: "x" }).success, false);
});

test("addCommitmentSchema: eight times a week still fails", () => {
  const r = addCommitmentSchema.safeParse({ name: "Caminar", cadenceKind: "times_per_week", cadenceN: 8, satisfaction: "tap" });
  assert.equal(r.success, false);
});

test("setRhythmSchema: the cap is the column's, a million", () => {
  assert.equal(setRhythmSchema.safeParse({ goalId: GOAL_ID, amount: 1_000_000 }).success, true);
  assert.equal(setRhythmSchema.safeParse({ goalId: GOAL_ID, amount: 1_000_001 }).success, false);
  assert.equal(setRhythmSchema.safeParse({ goalId: GOAL_ID, amount: 0 }).success, false);
});

test("tree.json holds the belowNoEnd words", () => {
  const tree = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "messages", "es", "tree.json"), "utf8"));
  assert.equal(tree.errors.belowNoEnd, "“{name}” no tiene final: dale uno antes.");
});
