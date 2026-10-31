import assert from "node:assert/strict";
import { test } from "node:test";

import { maxAmountMinor } from "@/lib/money";
import {
  movementFiltersSchema,
  movementTypeFilter,
  transactionFields,
  pesoAmountSchema,
} from "./transaction";

const schema = pesoAmountSchema({
  required: "required",
  invalid: "invalid",
  tooLarge: "tooLarge",
});

// Mutation: off by one in the cap comparison (`>` becomes `>=`, or the bound `+ 1`).
test("the amount schema takes the cap and refuses one cent above it", () => {
  const cap = maxAmountMinor("COP");
  const written = (minor: number) =>
    `${Math.trunc(minor / 100)},${String(minor % 100).padStart(2, "0")}`;

  assert.equal(schema.safeParse(written(cap)).success, true);

  const over = schema.safeParse(written(cap + 1));
  assert.equal(over.success, false);
  assert.deepEqual(over.error?.issues.map((issue) => issue.message), ["tooLarge"]);
});

// Mutation: leave `MOVEMENT_TYPES` at four.
test("the movement filter's URL takes adjustment", () => {
  assert.equal(movementFiltersSchema.parse({ type: "adjustment" }).type, "adjustment");
});

// Mutation: drop the `.catch("all")`.
test("an unknown movement type still reads all", () => {
  assert.equal(movementFiltersSchema.parse({ type: "Adjustment" }).type, "all");
  assert.equal(movementFiltersSchema.parse({ type: "x" }).type, "all");
});

// Mutation: map adjustment to `{ kind: "adjustment" }`.
test("adjustment maps to the adjustments flag alone", () => {
  assert.deepEqual(movementTypeFilter("adjustment"), { adjustments: true });
});

// Mutation: map all to `{ kind: "all" }`.
test("all maps to no predicate", () => {
  assert.deepEqual(movementTypeFilter("all"), {});
});

// Mutation: map income to `{ kind: "expense" }`.
test("the three kinds map one-to-one", () => {
  for (const kind of ["expense", "income", "transfer"] as const) {
    assert.deepEqual(movementTypeFilter(kind), { kind });
  }
});

test("«De quién» takes a member id or nothing, and refuses anything else", () => {
  const field = transactionFields.contributedByMemberId;
  assert.equal(field.safeParse(undefined).success, true);
  assert.equal(field.safeParse(null).success, true);
  assert.equal(field.safeParse("0b5f6a52-6f3b-4c4b-9f64-8c1f0f1d7a11").success, true);
  assert.equal(field.safeParse("not-an-id").success, false);
});
