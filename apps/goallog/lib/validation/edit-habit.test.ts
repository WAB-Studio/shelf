import assert from "node:assert/strict";
import test from "node:test";

import { editHabitSchema } from "./plan";

const id = "3f2b8f0e-1c1d-4b7a-9d3e-5a6b7c8d9e0f";

function issues(input: unknown): string[] {
  const result = editHabitSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

test("a blank name is refused as empty", () => {
  assert.deepEqual(issues({ commitmentId: id, name: "  ", note: "" }), ["plan.errors.nameEmpty"]);
});

test("a name of 121 characters is too long, 120 passes", () => {
  assert.deepEqual(issues({ commitmentId: id, name: "a".repeat(121), note: "" }), ["plan.errors.nameTooLong"]);
  assert.deepEqual(issues({ commitmentId: id, name: "a".repeat(120), note: "" }), []);
});

test("a note over 2000 characters is too long", () => {
  assert.deepEqual(issues({ commitmentId: id, name: "x", note: "n".repeat(2001) }), ["plan.errors.noteTooLong"]);
});

test("a bad id is refused", () => {
  assert.deepEqual(issues({ commitmentId: "nope", name: "x", note: "" }), ["plan.errors.commitmentInvalid"]);
});

test("a blank note clears to null and a note is trimmed", () => {
  const blank = editHabitSchema.parse({ commitmentId: id, name: " x ", note: "  " });
  assert.equal(blank.note, null);
  assert.equal(blank.name, "x");
  assert.equal(editHabitSchema.parse({ commitmentId: id, name: "x", note: " hola " }).note, "hola");
});

test("cadence fields are dropped, never passed through", () => {
  const parsed = editHabitSchema.parse({ commitmentId: id, name: "x", note: "", cadenceKind: "daily", quantity: 3 });
  assert.equal("cadenceKind" in parsed, false);
  assert.equal("quantity" in parsed, false);
  assert.deepEqual(Object.keys(parsed).sort(), ["commitmentId", "name", "note"]);
});
