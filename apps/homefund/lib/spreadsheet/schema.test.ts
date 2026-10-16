import assert from "node:assert/strict";
import { test } from "node:test";

import { LEGACY_ACCOUNT_SUBTYPES, accountRowSchema } from "./schema";

const row = {
  externalRef: null,
  name: "Cuenta",
  kind: "asset",
  subtype: "bank",
  placement: "personal",
  institution: null,
  lastFour: "",
  settlementCurrency: "COP",
  amount: "1000",
  balanceOn: "2020-01-01",
};

function parse(over: Record<string, unknown>) {
  return accountRowSchema.safeParse({ ...row, ...over });
}

function failures(over: Record<string, unknown>) {
  const result = parse(over);
  return result.success
    ? null
    : result.error.issues.map((i) => ({ message: i.message, path: i.path }));
}

test("the legacy keys are exactly the three old words", () => {
  assert.deepEqual({ ...LEGACY_ACCOUNT_SUBTYPES }, {
    bancaria: "bank",
    efectivo: "cash",
    tarjeta: "card",
  });
});

test("gate 1 maps each old word to its new one", () => {
  for (const [old, kind, word] of [
    ["bancaria", "asset", "bank"],
    ["efectivo", "asset", "cash"],
    ["tarjeta", "liability", "card"],
  ]) {
    const result = parse({ subtype: old, kind });
    assert.equal(result.success, true, old);
    assert.equal(result.data?.subtype, word);
  }
});

test("gate 1 passes a new word unchanged", () => {
  for (const [kind, word] of [
    ["asset", "bank"],
    ["asset", "cash"],
    ["liability", "card"],
  ]) {
    assert.equal(parse({ subtype: word, kind }).data?.subtype, word);
  }
});

test("gate 1 judges the kind after mapping", () => {
  assert.deepEqual(failures({ kind: "asset", subtype: "tarjeta" }), [
    { message: "accounts.errors.subtypeKindMismatch", path: ["subtype"] },
  ]);
  assert.deepEqual(failures({ kind: "liability", subtype: "efectivo" }), [
    { message: "accounts.errors.subtypeKindMismatch", path: ["subtype"] },
  ]);
});

test("gate 1 maps exact keys only", () => {
  for (const cell of ["Bancaria", " bancaria", "EFECTIVO", "tarjeta ", "banco"]) {
    assert.deepEqual(failures({ subtype: cell }), [
      { message: "accounts.errors.subtypeInvalid", path: ["subtype"] },
    ], cell);
  }
});

test("the blank currency fallback still holds beside a mapped word", () => {
  const result = parse({ settlementCurrency: null, subtype: "efectivo" });
  assert.equal(result.success, true);
  assert.equal(result.data?.settlementCurrency, "COP");
  assert.equal(result.data?.subtype, "cash");
});
