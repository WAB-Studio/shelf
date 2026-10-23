import assert from "node:assert/strict";
import { test } from "node:test";

import { LEGACY_ACCOUNT_SUBTYPES, accountRowSchema, transactionRowSchema, transactionSheetDescriptor } from "./schema";

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

const spendRow = {
  externalRef: null,
  fromAccount: "Tarjeta COP",
  toAccount: null,
  amount: "25",
  category: "Food",
  occurredAt: "2026-01-10",
  description: null,
};

test("RF-142: the transaction sheet carries counterAmount as a money column and counterIsEstimate as a flag", () => {
  const columns = transactionSheetDescriptor.columns as readonly { key: string; money?: unknown; flag?: true; field?: string }[];
  const counter = columns.find((c) => c.key === "counterAmount");
  const estimate = columns.find((c) => c.key === "counterIsEstimate");
  assert.ok(counter?.money, "counterAmount is read through the money boundary");
  assert.equal(counter?.field, "counterAmountCents");
  assert.equal(estimate?.field, "counterIsEstimate");
  assert.ok(columns.findIndex((c) => c.key === "currency") < columns.findIndex((c) => c.key === "counterAmount"));
});

test("RF-142: the row schema keeps a second amount and its estimate mark", () => {
  const result = transactionRowSchema.safeParse({ ...spendRow, currency: "USD", counterAmount: "105000", counterIsEstimate: true });
  assert.equal(result.success, true);
  const data = result.data as { counterAmount?: string; counterIsEstimate?: boolean };
  assert.equal(data.counterAmount, "105000");
  assert.equal(data.counterIsEstimate, true);
});

test("RF-142: a row without the two cells still passes the row schema", () => {
  assert.equal(transactionRowSchema.safeParse({ ...spendRow, currency: null }).success, true);
  assert.equal(transactionRowSchema.safeParse(spendRow).success, true);
});

test("RF-122: a second amount that is not an amount is refused at its own column", () => {
  const result = transactionRowSchema.safeParse({ ...spendRow, currency: "USD", counterAmount: "abc", counterIsEstimate: null });
  assert.equal(result.success, false);
  assert.ok(result.error?.issues.some((i) => i.path[0] === "counterAmount"));
});

// ---- M3: an account's opening amount read off a backup (RF-142, RF-51) -------------------------

const card = { kind: "liability", subtype: "card" };

test("RF-142: a card row whose opening carries the minus a backup writes passes, read as what is owed", () => {
  for (const amount of ["-150000,00", "-150000", "-150.000,00"]) {
    assert.deepEqual(failures({ ...card, amount }), null, amount);
  }
});

test("RF-142: a card row whose opening is written without a sign passes as it always did", () => {
  for (const amount of ["150000,00", "150000"]) {
    assert.deepEqual(failures({ ...card, amount }), null, amount);
  }
});

test("RF-51: an asset row with a negative opening stays refused, with the form's key on the amount", () => {
  for (const amount of ["-100", "-100,00", "-1"]) {
    assert.deepEqual(failures({ kind: "asset", subtype: "bank", amount }), [
      { message: "accounts.errors.amountInvalid", path: ["amount"] },
    ], amount);
  }
});

// The minus a tool writes for a card opened in debt is the typographic one (U+2212) as often as the ASCII
// one, and a cell can carry leading spaces before it: each still reads as the magnitude owed.
function openingOf(amount: string) {
  const result = parse({ ...card, amount });
  assert.equal(result.success, true, `«${amount}» passes`);
  return (result.data as { amount: unknown }).amount;
}

test("RF-142: a card opening written with the Unicode minus reads as the same magnitude", () => {
  assert.deepEqual(openingOf("−150000"), openingOf("150000"));
  assert.deepEqual(openingOf("−150.000,00"), openingOf("150.000,00"));
});

test("RF-142: a card opening with leading spaces before its minus reads as the same magnitude", () => {
  assert.deepEqual(openingOf("  -150000"), openingOf("150000"));
  assert.deepEqual(openingOf("\t −150000"), openingOf("150000"));
});
