import assert from "node:assert/strict";
import test from "node:test";

import plan from "../../messages/es/plan.json";
import {
  changeGoalMeasureSchema,
  deleteGoalSchema,
  removeGoalMeasureSchema,
  removeRhythmSchema,
} from "./goal-edit";

const goalId = "6f1c9a52-3c1e-4d0e-9a43-1d2f7b8e9c10";

function refusal(schema: typeof deleteGoalSchema, input: unknown): string | null {
  const parsed = schema.safeParse(input);
  return parsed.success ? null : parsed.error.issues[0].message;
}

test("the acts that take a goal alone accept a uuid and refuse anything else", () => {
  for (const schema of [deleteGoalSchema, removeGoalMeasureSchema, removeRhythmSchema]) {
    assert.equal(refusal(schema, { goalId }), null);
    assert.equal(refusal(schema, { goalId: "nope" }), "plan.errors.goalInvalid");
    assert.equal(refusal(schema, {}), "plan.errors.goalInvalid");
    assert.equal(refusal(schema, null), "plan.errors.goalInvalid");
  }
});

test("changeGoalMeasureSchema: the name and the unit are trimmed and bounded as the first measure's are", () => {
  const ok = changeGoalMeasureSchema.safeParse({ goalId, name: "  Páginas ", unit: " páginas " });
  assert.equal(ok.success, true);
  if (ok.success) assert.deepEqual(ok.data, { goalId, name: "Páginas", unit: "páginas" });
  const refused = (input: unknown) => {
    const parsed = changeGoalMeasureSchema.safeParse(input);
    return parsed.success ? null : parsed.error.issues[0].message;
  };
  assert.equal(refused({ goalId, name: " ", unit: "km" }), "plan.errors.nameEmpty");
  assert.equal(refused({ goalId, name: "a".repeat(121), unit: "km" }), "plan.errors.nameTooLong");
  assert.equal(refused({ goalId, name: "Km", unit: "" }), "plan.errors.unitEmpty");
  assert.equal(refused({ goalId, name: "Km", unit: "u".repeat(41) }), "plan.errors.unitTooLong");
  assert.equal(refused({ goalId: "nope", name: "Km", unit: "km" }), "plan.errors.goalInvalid");
});

test("plan.json: every refusal the goal-edit acts answer is written", () => {
  const errors = plan.errors as Record<string, string>;
  for (const key of ["goalHasFacts", "goalHoldsGoals", "measureFed", "noMeasure", "goalNotFound", "holderNoMeasure", "goalInvalid"]) {
    assert.ok(errors[key]?.length > 0, key);
  }
});
