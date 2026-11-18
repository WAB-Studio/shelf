import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { codeOf, debtLikeName, personOwesAccount, type Probe } from "./debt-words";

const labels = new Map([
  ["deudas", "Deudas"],
  ["ahorro", "Ahorro"],
  ["mercado", "Mercado"],
  ["lacteos", "Mercado Lácteos"],
]);
const probe = (kind: Probe["kind"], description: string | null, ...categoryIds: string[]): Probe => ({ kind, description, categoryIds });

describe("debtLikeName", () => {
  it("reads a debt, a loan, a card, a saving or a transfer as an account, with or without accents", () => {
    for (const name of ["Deudas", "Préstamos", "Crédito", "Tarjeta BBVA", "Ahorro", "Traslados"]) {
      assert.equal(debtLikeName(name), true, name);
    }
  });

  it("leaves an ordinary category alone", () => {
    for (const name of ["Mercado", "Transporte", "Suscripciones", "Regalos"]) assert.equal(debtLikeName(name), false, name);
  });
});

describe("codeOf", () => {
  it("warns an expense that pays a card, a loan or a payroll loan", () => {
    for (const description of ["Pago de tarjeta BBVA", "pago tarjeta", "Cuota libranza", "Abono a crédito", "Préstamo a Juan"]) {
      assert.equal(codeOf(probe("expense", description), labels), "debtAsExpense", description);
    }
  });

  it("warns an expense sitting in a debt category, even with a plain description", () => {
    assert.equal(codeOf(probe("expense", "Transferencia", "deudas"), labels), "debtAsExpense");
  });

  it("warns an expense that saves", () => {
    assert.equal(codeOf(probe("expense", "Ahorro mensual"), labels), "savingsAsExpense");
    assert.equal(codeOf(probe("expense", null, "ahorro"), labels), "savingsAsExpense");
  });

  it("warns an income that reads as a disbursement or a collection", () => {
    assert.equal(codeOf(probe("income", "Pago de préstamo recibido"), labels), "loanAsIncome");
    assert.equal(codeOf(probe("income", "Desembolso crédito"), labels), "loanAsIncome");
    assert.equal(codeOf(probe("income", "Cobro", "deudas"), labels), "loanAsIncome");
  });

  it("stays quiet on what is an ordinary expense or income", () => {
    assert.equal(codeOf(probe("expense", "Ara — Champiñón 250 g", "lacteos"), labels), null);
    assert.equal(codeOf(probe("expense", "Café (tarjeta débito)", "mercado"), labels), null);
    assert.equal(codeOf(probe("income", "Nómina"), labels), null);
  });
});

describe("personOwesAccount", () => {
  it("reads a receivable and a name that says «Me debe …» as what a person owes, however it is spelled", () => {
    assert.equal(personOwesAccount("receivable", "Cuenta"), true);
    for (const name of ["Me debe Yulieth", "  me debe mamá", "ME DEBE Carlos"]) assert.equal(personOwesAccount("bank", name), true, name);
  });

  it("leaves an ordinary account alone", () => {
    for (const name of ["Bancolombia", "Efectivo", "Medebe SAS"]) assert.equal(personOwesAccount("bank", name), false, name);
  });
});
