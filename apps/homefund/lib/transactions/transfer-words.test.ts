import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { narrateTransfers, transferWords, type TransferSide } from "./transfer-words";

const side = (over: Partial<TransferSide> & { name: string }): TransferSide => ({
  subtype: "bank",
  institution: null,
  internalPersonName: null,
  ...over,
});

describe("transferWords", () => {
  it("names a loan payment by the lender, never by the accounts", () => {
    const words = transferWords(
      side({ name: "Ahorros" }),
      side({ name: "Crédito Lulo", subtype: "loan", institution: "Lulo" }),
    );
    assert.deepEqual(words, { kind: "loanPayment", name: "Lulo" });
  });

  it("falls back to the loan's name when it has no institution", () => {
    const words = transferWords(side({ name: "Ahorros" }), side({ name: "Crédito carro", subtype: "loan" }));
    assert.equal(words.kind === "loanPayment" && words.name, "Crédito carro");
  });

  it("says who paid when the money leaves a payer's hidden account", () => {
    const words = transferWords(
      side({ name: "Me debe John", subtype: "receivable", internalPersonName: "John" }),
      side({ name: "Ahorros" }),
    );
    assert.deepEqual(words, { kind: "payerPaid", name: "John" });
  });

  it("names a card payment by the card", () => {
    const words = transferWords(side({ name: "Ahorros" }), side({ name: "Visa", subtype: "card" }));
    assert.deepEqual(words, { kind: "cardPayment", name: "Visa" });
  });

  it("leaves a plain move between two assets as between", () => {
    assert.equal(transferWords(side({ name: "Ahorros" }), side({ name: "Efectivo", subtype: "cash" })).kind, "between");
  });
});

describe("narrateTransfers", () => {
  const sides = new Map<string, TransferSide>([
    ["john", side({ name: "Me debe John", subtype: "receivable", internalPersonName: "John" })],
    ["ahorros", side({ name: "Ahorros" })],
    ["lulo", side({ name: "Crédito Lulo", subtype: "loan", institution: "Lulo" })],
    ["efectivo", side({ name: "Efectivo", subtype: "cash" })],
  ]);
  const names = new Map([...sides].map(([id, one]) => [id, one.name]));
  const t = (key: string, values?: { name: string }) => `${key}:${values?.name ?? ""}`;
  const row = (id: string, from: string, to: string) => ({
    id, kind: "transfer", reconciliationId: null, fromAccountId: from, toAccountId: to,
  });

  it("never lets a hidden account or a debt's name reach the title", () => {
    const out = narrateTransfers(
      [row("1", "john", "ahorros"), row("2", "ahorros", "lulo"), row("3", "ahorros", "efectivo")],
      sides, names, t,
    );
    assert.deepEqual(out.get("1"), { title: "transferPayerPaid:John", account: "Ahorros" });
    assert.deepEqual(out.get("2"), { title: "transferLoanPayment:Lulo", account: "Ahorros" });
    assert.deepEqual(out.get("3"), { title: "kindTransfer:", account: "Ahorros → Efectivo" });
  });

  it("skips what is no plain transfer", () => {
    const out = narrateTransfers(
      [{ ...row("4", "ahorros", "lulo"), kind: "expense" }, { ...row("5", "ahorros", "lulo"), reconciliationId: "r" }],
      sides, names, t,
    );
    assert.equal(out.size, 0);
  });
});
