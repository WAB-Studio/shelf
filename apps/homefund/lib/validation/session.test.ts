import assert from "node:assert/strict";
import { test } from "node:test";

import { keepDaysOf, keepSignedInSchema } from "./session";

test("RF-190: «Siempre» is a choice and stores no limit", () => {
  const parsed = keepSignedInSchema.parse({ days: "always" });
  assert.equal(keepDaysOf(parsed.days), null);
});

test("RF-190: a listed number of days stores that number", () => {
  assert.equal(keepDaysOf(keepSignedInSchema.parse({ days: "30" }).days), 30);
});

test("RF-190: a number nobody offered, or no choice, is refused", () => {
  for (const days of ["0", "45", "-7", "7.5", "", "never", 7, null, undefined]) {
    assert.equal(keepSignedInSchema.safeParse({ days }).success, false, String(days));
  }
});
