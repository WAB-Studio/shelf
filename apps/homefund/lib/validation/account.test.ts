import assert from "node:assert/strict";
import { test } from "node:test";

import type { z } from "zod";

import {
  ACCOUNT_SUBTYPES,
  SUBTYPES_BY_KIND,
  createAccountSchema,
  updateAccountSchema,
} from "./account";

const createBase = {
  name: "Cuenta",
  kind: "asset",
  subtype: "bank",
  placement: "personal",
  institution: null,
  settlementCurrency: "COP",
  amount: "1000",
  balanceOn: "2020-01-01",
};

const updateBase = {
  accountId: "11111111-1111-4111-8111-111111111111",
  name: "Cuenta",
  kind: "asset",
  subtype: "bank",
  isShared: false,
  institution: null,
  settlementCurrency: "COP",
  amount: "1000",
  balanceOn: "2020-01-01",
};

function issues(schema: z.ZodType, input: unknown) {
  const result = schema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((i) => ({ message: i.message, path: i.path }));
}

test("the form's list is the new words", () => {
  assert.deepEqual([...ACCOUNT_SUBTYPES], ["bank", "cash", "card"]);
  assert.deepEqual(
    { asset: [...SUBTYPES_BY_KIND.asset], liability: [...SUBTYPES_BY_KIND.liability] },
    { asset: ["bank", "cash"], liability: ["card"] },
  );
});

test("create refuses an old word with one subtypeInvalid issue", () => {
  for (const old of ["bancaria", "efectivo", "tarjeta"]) {
    assert.deepEqual(issues(createAccountSchema, { ...createBase, subtype: old }), [
      { message: "accounts.errors.subtypeInvalid", path: ["subtype"] },
    ]);
  }
});

test("update refuses an old word with one subtypeInvalid issue", () => {
  for (const old of ["bancaria", "efectivo", "tarjeta"]) {
    assert.deepEqual(issues(updateAccountSchema, { ...updateBase, subtype: old }), [
      { message: "accounts.errors.subtypeInvalid", path: ["subtype"] },
    ]);
  }
});

test("create refuses cash on a liability", () => {
  assert.deepEqual(issues(createAccountSchema, { ...createBase, kind: "liability", subtype: "cash" }), [
    { message: "accounts.errors.subtypeKindMismatch", path: ["subtype"] },
  ]);
});

test("update refuses a card on an asset", () => {
  assert.deepEqual(issues(updateAccountSchema, { ...updateBase, kind: "asset", subtype: "card" }), [
    { message: "accounts.errors.subtypeKindMismatch", path: ["subtype"] },
  ]);
});

test("create accepts each valid pair and returns the same word", () => {
  for (const [kind, subtype] of [
    ["asset", "bank"],
    ["asset", "cash"],
    ["liability", "card"],
  ]) {
    const result = createAccountSchema.safeParse({ ...createBase, kind, subtype });
    assert.equal(result.success, true);
    assert.equal(result.data?.subtype, subtype);
  }
});
