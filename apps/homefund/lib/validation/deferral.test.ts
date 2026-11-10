import assert from "node:assert/strict";
import { test } from "node:test";

import { statementRowSchema } from "./statement-import";
import { deferPurchaseSchema, undeferPurchaseSchema } from "./deferral";

const transactionId = "11111111-1111-4111-8111-111111111111";

test("a deferral takes a whole number of instalments from 2 to 72", () => {
  for (const instalments of [2, 36, 72]) {
    assert.equal(deferPurchaseSchema.safeParse({ transactionId, instalments }).success, true, String(instalments));
  }
  for (const instalments of [0, 1, 73, 12.5, Number.NaN, "12"]) {
    const verdict = deferPurchaseSchema.safeParse({ transactionId, instalments });
    assert.equal(verdict.success, false, String(instalments));
    if (!verdict.success) assert.equal(verdict.error.issues[0].message, "deferrals.errors.instalmentsInvalid");
  }
});

test("a deferral names a movement by id", () => {
  assert.equal(deferPurchaseSchema.safeParse({ transactionId: "x", instalments: 12 }).success, false);
  assert.equal(undeferPurchaseSchema.safeParse({ transactionId }).success, true);
  assert.equal(undeferPurchaseSchema.safeParse({}).success, false);
});

test("a statement line may carry the instalments the statement printed, within the same bounds", () => {
  const line = { line: 1, date: "2026-03-15", description: "Nevera", amountCents: -100000 };
  assert.equal(statementRowSchema.safeParse({ ...line, instalments: 36 }).success, true);
  assert.equal(statementRowSchema.safeParse(line).success, true);
  for (const instalments of [1, 73, 2.5]) {
    assert.equal(statementRowSchema.safeParse({ ...line, instalments }).success, false, String(instalments));
  }
});
