import assert from "node:assert/strict";
import { test } from "node:test";

import { formatRatePercent, percentToFraction, rateSchema } from "./debt-terms";

const schema = rateSchema({ required: "required", invalid: "invalid" });

function messages(value: string): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

test("a rate typed with a comma is accepted and reads as the same fraction as with a dot", () => {
  assert.deepEqual(messages("28,5"), []);
  assert.deepEqual(messages("28.5"), []);
  assert.equal(percentToFraction("28,5"), "0.285");
  assert.equal(percentToFraction("28,5"), percentToFraction("28.5"));
  assert.equal(percentToFraction("16,50"), "0.1650");
});

test("a rate that is no number, or has two separators, is refused; an empty one is required", () => {
  assert.deepEqual(messages("28,5,1"), ["invalid"]);
  assert.deepEqual(messages("abc"), ["invalid"]);
  assert.deepEqual(messages("-3"), ["invalid"]);
  assert.deepEqual(messages("  "), ["required"]);
});

test("a stored fraction reads back as the percentage that was typed, never as a monthly step", () => {
  assert.equal(formatRatePercent("0.2850"), "28,5");
  assert.equal(formatRatePercent("0.28"), "28");
  assert.equal(formatRatePercent("0.165", "."), "16.5");
});
