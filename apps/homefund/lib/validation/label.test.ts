import assert from "node:assert/strict";
import { test } from "node:test";

import { alreadyOwedOf, createLabelSchema, updateLabelSchema } from "./label";

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

const PERSON = { name: "Yulieth", color: COLOR, placement: "personal", kind: "person" };
const OWED = { amount: "385.766", currency: "COP", since: "2026-03-01" };

test("a person may carry what they already owed, read in its own currency and turned into integer cents", () => {
  const result = createLabelSchema.safeParse({ ...PERSON, alreadyOwed: OWED });
  assert.equal(result.success, true);
  assert.deepEqual(result.success && alreadyOwedOf(result.data.alreadyOwed), { cents: 38_576_600, currency: "COP", since: "2026-03-01" });
});

test("what a person already owed is absent, null or a value, and the three read differently", () => {
  assert.equal(alreadyOwedOf(undefined), undefined);
  assert.equal(alreadyOwedOf(null), null);
  const edit = (alreadyOwed: unknown) => updateLabelSchema.safeParse({ labelId: crypto.randomUUID(), name: "Yulieth", color: COLOR, alreadyOwed });
  assert.equal(edit(undefined).success, true);
  assert.equal(edit(null).success, true);
  assert.equal(edit(OWED).success, true);
});

test("what a person already owed refuses a blank or zero amount, a date in the future and a currency nobody offers", () => {
  assert.deepEqual(messages({ ...PERSON, alreadyOwed: { ...OWED, amount: "" } }), ["labels.errors.alreadyOwedAmountRequired"]);
  assert.deepEqual(messages({ ...PERSON, alreadyOwed: { ...OWED, amount: "0" } }), ["labels.errors.alreadyOwedAmountInvalid"]);
  assert.deepEqual(messages({ ...PERSON, alreadyOwed: { ...OWED, amount: "mucho" } }), ["labels.errors.alreadyOwedAmountInvalid"]);
  assert.deepEqual(messages({ ...PERSON, alreadyOwed: { ...OWED, since: "2999-01-01" } }), ["labels.errors.alreadyOwedDateInFuture"]);
  assert.deepEqual(messages({ ...PERSON, alreadyOwed: { ...OWED, since: "ayer" } }), ["labels.errors.alreadyOwedDateInvalid"]);
  assert.deepEqual(messages({ ...PERSON, alreadyOwed: { ...OWED, currency: "EUR" } }), ["labels.errors.alreadyOwedCurrencyInvalid"]);
});

test("a tag cannot already owe", () => {
  assert.deepEqual(messages({ ...PERSON, kind: "tag", alreadyOwed: OWED }), ["labels.errors.alreadyOwedNeedsPerson"]);
});
