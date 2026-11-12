import assert from "node:assert/strict";
import { test } from "node:test";

import { maxAmountMinor } from "@/lib/money";
import {
  MOVEMENT_SEARCH_MAX,
  movementFiltersSchema,
  movementTypeFilter,
  transactionFields,
  pesoAmountSchema,
  refineContributor,
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

test("«De quién» is required on an income into a fund account and nowhere else", () => {
  const issues = (
    data: Parameters<ReturnType<typeof refineContributor>>[0],
    intoFund: boolean,
  ) => {
    const found: string[] = [];
    refineContributor(intoFund)(data, {
      addIssue: (issue: unknown) => {
        found.push((issue as { message: string }).message);
      },
    } as never);
    return found;
  };
  const member = "0b5f6a52-6f3b-4c4b-9f64-8c1f0f1d7a11";
  const account = "5d1c1a0e-0d7e-4f3b-8a7e-2f1a0c9b6d33";

  assert.deepEqual(issues({ fromAccountId: null, toAccountId: account }, true), [
    "transactions.errors.contributorRequired",
  ]);
  assert.deepEqual(
    issues({ fromAccountId: null, toAccountId: account, contributedByMemberId: null }, true),
    ["transactions.errors.contributorRequired"],
  );
  assert.deepEqual(
    issues({ fromAccountId: null, toAccountId: account, contributedByMemberId: member }, true),
    [],
  );
  // Not into the fund, not an income: nothing is asked.
  assert.deepEqual(issues({ fromAccountId: null, toAccountId: account }, false), []);
  assert.deepEqual(issues({ fromAccountId: account, toAccountId: null }, true), []);
  assert.deepEqual(issues({ fromAccountId: member, toAccountId: account }, true), []);
});

// Mutation: drop the trim, or let an empty `q` through as a filter.
test("the movement search trims its text and drops an empty or oversized one", () => {
  assert.equal(movementFiltersSchema.parse({ q: "  café  " }).q, "café");
  assert.equal(movementFiltersSchema.parse({ q: "   " }).q, undefined);
  assert.equal(movementFiltersSchema.parse({}).q, undefined);
  assert.equal(movementFiltersSchema.parse({ q: "x".repeat(MOVEMENT_SEARCH_MAX + 1) }).q, undefined);
  assert.equal(movementFiltersSchema.parse({ q: "x".repeat(MOVEMENT_SEARCH_MAX) }).q?.length, MOVEMENT_SEARCH_MAX);
});
