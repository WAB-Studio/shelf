import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cardStatementExtrasSchema } from "./card-statement";

const deferral = {
  authorizationNumber: "AUT-0001",
  description: "AMPLIACION DE PLAZO",
  currency: "COP",
  originalAmountCents: 804_500_000,
  instalments: 24,
  currentInstalment: 7,
  monthlyInstalmentCents: 33_520_000,
  pendingBalanceCents: 471_000_000,
  annualRatePct: "28.1",
};

const message = (extras: unknown) => {
  const verdict = cardStatementExtrasSchema.safeParse(extras);
  return verdict.success ? "ok" : verdict.error.issues[0].message;
};

describe("cardStatementExtrasSchema", () => {
  it("accepts a deferral and a purchase as a statement prints them", () => {
    assert.equal(
      message({ deferrals: [deferral], purchases: [{ occurredOn: "2026-11-05", amountCents: 45_000_00, currency: "COP" }] }),
      "ok",
    );
  });

  it("refuses a current instalment past the total and one under 1", () => {
    assert.equal(message({ deferrals: [{ ...deferral, currentInstalment: 25 }], purchases: [] }), "cardStatement.errors.currentInstalmentInvalid");
    assert.equal(message({ deferrals: [{ ...deferral, currentInstalment: 0 }], purchases: [] }), "cardStatement.errors.currentInstalmentInvalid");
  });

  it("refuses a fractional amount, an unknown currency and a rate that is no number", () => {
    assert.equal(message({ deferrals: [{ ...deferral, pendingBalanceCents: 10.5 }], purchases: [] }), "cardStatement.errors.amountInvalid");
    assert.equal(message({ deferrals: [{ ...deferral, currency: "XXY" }], purchases: [] }), "cardStatement.errors.currencyInvalid");
    assert.equal(message({ deferrals: [{ ...deferral, annualRatePct: "veintiocho" }], purchases: [] }), "debts.errors.rateInvalid");
  });

  it("refuses the same authorization number twice and a purchase on a day that does not exist", () => {
    assert.equal(message({ deferrals: [deferral, deferral], purchases: [] }), "cardStatement.errors.authorizationRepeated");
    assert.equal(
      message({ deferrals: [], purchases: [{ occurredOn: "2026-02-31", amountCents: 100, currency: "COP" }] }),
      "cardStatement.errors.dateInvalid",
    );
  });
});
