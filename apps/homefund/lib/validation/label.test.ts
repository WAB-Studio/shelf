import assert from "node:assert/strict";
import { test } from "node:test";

import { createLabelSchema, updateLabelSchema } from "./label";

const COLOR = "#3B82F6";

function messages(input: unknown): string[] {
  const result = createLabelSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

test("a label sent with no kind is a tag that charges nobody", () => {
  const result = createLabelSchema.safeParse({ name: "Viaje", color: COLOR, placement: "personal" });
  assert.equal(result.success, true);
  assert.deepEqual(
    result.success && { kind: result.data.kind, chargeDefault: result.data.chargeDefault },
    { kind: "tag", chargeDefault: false },
  );
});

test("a person may be charged by default and a tag may not", () => {
  const person = { name: "Ángela", color: COLOR, placement: "personal", kind: "person", chargeDefault: true };
  assert.equal(createLabelSchema.safeParse(person).success, true);
  assert.deepEqual(messages({ ...person, kind: "tag" }), ["labels.errors.chargeNeedsPerson"]);
});

test("a kind outside tag and person is refused with its own message", () => {
  assert.deepEqual(
    messages({ name: "Ángela", color: COLOR, placement: "personal", kind: "pet" }),
    ["labels.errors.kindInvalid"],
  );
});

test("an edit leaves the default to charge alone unless it is sent, and never changes the kind", () => {
  const edit = { labelId: crypto.randomUUID(), name: "Ángela", color: COLOR };
  const kept = updateLabelSchema.safeParse(edit);
  assert.equal(kept.success && kept.data.chargeDefault, undefined);
  const flipped = updateLabelSchema.safeParse({ ...edit, chargeDefault: true, kind: "tag" });
  assert.equal(flipped.success && flipped.data.chargeDefault, true);
  assert.equal(flipped.success && "kind" in flipped.data, false);
});
