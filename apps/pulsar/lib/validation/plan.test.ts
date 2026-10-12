import assert from "node:assert/strict";
import test from "node:test";

import {
  addCommitmentSchema,
  addPhaseSchema,
  archiveGoalSchema,
  createGoalSchema,
  moveGoalSchema,
  phasesOverlap,
  renameGoalSchema,
  reopenGoalSchema,
  setGoalNoteSchema,
} from "./plan";

const GOAL_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

function phaseInput(startsOn: string, endsOn: string) {
  return { goalId: GOAL_ID, aim: "leer despacio", startsOn, endsOn };
}

// RP-15: a phase is a span of weeks. A span whose end precedes its start
// names no span at all and must never reach the database — mirrors
// `phases_ends_on_after_starts_on`.
test("addPhaseSchema: refuses a phase whose end precedes its start", () => {
  const result = addPhaseSchema.safeParse(phaseInput("2026-02-10", "2026-02-01"));
  assert.equal(result.success, false);
});

test("addPhaseSchema: accepts a phase whose end is the same day as its start", () => {
  const result = addPhaseSchema.safeParse(phaseInput("2026-02-10", "2026-02-10"));
  assert.equal(result.success, true);
});

test("addPhaseSchema: accepts a phase whose end follows its start", () => {
  const result = addPhaseSchema.safeParse(phaseInput("2026-02-01", "2026-02-28"));
  assert.equal(result.success, true);
});

// RP-15: the day names one phase (`phaseOn`, lib/day/derive.ts). Two spans
// that would leave it a choice must be refused.
test("phasesOverlap: two spans sharing a middle day overlap", () => {
  const a = { startsOn: "2026-02-01", endsOn: "2026-02-28" };
  const b = { startsOn: "2026-02-15", endsOn: "2026-03-15" };
  assert.equal(phasesOverlap(a, b), true);
});

test("phasesOverlap: one span ending the day another starts still overlap", () => {
  const a = { startsOn: "2026-02-01", endsOn: "2026-02-15" };
  const b = { startsOn: "2026-02-15", endsOn: "2026-02-28" };
  assert.equal(phasesOverlap(a, b), true);
});

test("phasesOverlap: a span starting the day after another ends do not overlap", () => {
  const a = { startsOn: "2026-02-01", endsOn: "2026-02-14" };
  const b = { startsOn: "2026-02-15", endsOn: "2026-02-28" };
  assert.equal(phasesOverlap(a, b), false);
});

// RP-23: the same trim/require/120-character rule `createGoalSchema`'s own
// name field already carries.
test("renameGoalSchema: trims the name before it ever reaches the database", () => {
  const result = renameGoalSchema.safeParse({ goalId: GOAL_ID, name: "  meta renombrada  " });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.name, "meta renombrada");
});

test("renameGoalSchema: refuses a name that is empty once trimmed", () => {
  const result = renameGoalSchema.safeParse({ goalId: GOAL_ID, name: "   " });
  assert.equal(result.success, false);
});

test("renameGoalSchema: refuses a name past 120 characters", () => {
  const result = renameGoalSchema.safeParse({ goalId: GOAL_ID, name: "a".repeat(121) });
  assert.equal(result.success, false);
});

// RP-24: neither act asks for anything but the goal itself.
test("archiveGoalSchema: refuses a goalId that is not a uuid", () => {
  const result = archiveGoalSchema.safeParse({ goalId: "not-a-uuid" });
  assert.equal(result.success, false);
});

test("reopenGoalSchema: accepts a real goalId and nothing else", () => {
  const result = reopenGoalSchema.safeParse({ goalId: GOAL_ID });
  assert.equal(result.success, true);
});

// RP-12: a week holds 7 days, a year 365, a month at most 31.
const CADENCE_BOUNDS = [
  ["times_per_week", 7, "plan.errors.timesPerWeekInvalid"],
  ["every_n_days", 365, "plan.errors.everyNDaysInvalid"],
  ["times_per_month", 31, "plan.errors.timesPerMonthInvalid"],
] as const;

function commitmentInput(cadenceKind: string, cadenceN: number) {
  return { goalId: GOAL_ID, name: "leer", satisfaction: "tap", cadenceKind, cadenceN };
}

for (const [kind, max, key] of CADENCE_BOUNDS) {
  test(`addCommitmentSchema: ${kind} accepts 1 and ${max}`, () => {
    assert.equal(addCommitmentSchema.safeParse(commitmentInput(kind, 1)).success, true);
    assert.equal(addCommitmentSchema.safeParse(commitmentInput(kind, max)).success, true);
  });

  test(`addCommitmentSchema: ${kind} refuses 0 and ${max + 1} with ${key}`, () => {
    for (const n of [0, max + 1]) {
      const result = addCommitmentSchema.safeParse(commitmentInput(kind, n));
      assert.equal(result.success, false);
      if (!result.success) assert.equal(result.error.issues[0].message, key);
    }
  });
}

test("createGoalSchema: parentId is optional and must be a uuid", () => {
  const base = { name: "Dentro", horizon: "2027-01-01" };
  assert.equal(createGoalSchema.safeParse(base).success, true);
  assert.equal(createGoalSchema.safeParse({ ...base, parentId: GOAL_ID }).success, true);
  assert.equal(createGoalSchema.safeParse({ ...base, parentId: "nope" }).success, false);
});

test("moveGoalSchema: parentId is a uuid or null, never absent", () => {
  assert.equal(moveGoalSchema.safeParse({ goalId: GOAL_ID, parentId: null }).success, true);
  assert.equal(moveGoalSchema.safeParse({ goalId: GOAL_ID, parentId: GOAL_ID }).success, true);
  assert.equal(moveGoalSchema.safeParse({ goalId: GOAL_ID }).success, false);
});

test("setGoalNoteSchema: trims, turns blank into null, refuses past 20000", () => {
  const parse = (note: string) => setGoalNoteSchema.safeParse({ goalId: GOAL_ID, note });
  const lines = parse("  uno\ndos\ntres \n");
  assert.equal(lines.success && lines.data.note, "uno\ndos\ntres");
  const blank = parse("  \n ");
  assert.equal(blank.success && blank.data.note, null);
  assert.equal(parse("x".repeat(20000)).success, true);
  const long = parse("x".repeat(20001));
  assert.equal(long.success, false);
  assert.equal(!long.success && long.error.issues[0].message, "tree.errors.noteTooLong");
});
