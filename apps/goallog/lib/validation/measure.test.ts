import assert from "node:assert/strict";
import test from "node:test";

import plan from "../../messages/es/plan.json";
import { setGoalMeasureSchema } from "./measure";

const goalId = "6f1c9a52-3c1e-4d0e-9a43-1d2f7b8e9c10";

function refusal(input: unknown): string | null {
  const parsed = setGoalMeasureSchema.safeParse(input);
  return parsed.success ? null : parsed.error.issues[0].message;
}

// RP-117: the name and the unit are trimmed before they are measured, and the same schema serves the form.
test("setGoalMeasureSchema: name 1 to 120, unit 1 to 40, both trimmed", () => {
  const ok = setGoalMeasureSchema.safeParse({ goalId, name: "  Cajas embaladas ", unit: " cajas " });
  assert.equal(ok.success, true);
  if (ok.success) assert.deepEqual(ok.data, { goalId, name: "Cajas embaladas", unit: "cajas" });

  assert.equal(refusal({ goalId, name: "   ", unit: "cajas" }), "plan.errors.nameEmpty");
  assert.equal(refusal({ goalId, name: "a".repeat(120), unit: "cajas" }), null);
  assert.equal(refusal({ goalId, name: "a".repeat(121), unit: "cajas" }), "plan.errors.nameTooLong");
  assert.equal(refusal({ goalId, name: "Km", unit: "" }), "plan.errors.unitEmpty");
  assert.equal(refusal({ goalId, name: "Km", unit: "u".repeat(40) }), null);
  assert.equal(refusal({ goalId, name: "Km", unit: "u".repeat(41) }), "plan.errors.unitTooLong");
});

test("setGoalMeasureSchema: a goalId that is no uuid is refused", () => {
  assert.equal(refusal({ goalId: "nope", name: "Km", unit: "km" }), "plan.errors.goalInvalid");
});

test("plan.json: the two refusals the act adds are written", () => {
  const errors = plan.errors as Record<string, string>;
  assert.ok(errors.measureKept?.length > 0);
  assert.ok(errors.holderNoMeasure?.length > 0);
});
