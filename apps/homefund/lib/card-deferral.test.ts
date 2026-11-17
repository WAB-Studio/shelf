import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chargesInterest, deferralCost, monthlyInterestCents, monthlyRatePpb, remainingInterestCents } from "./card-deferral";

// A synthetic extension of term: 24 instalments of an 80.450.000 plan, 28,1 % effective annual, 47.100.000 pending.
const extension = { originalAmountCents: 804_500_000, instalments: 24, pendingBalanceCents: 471_000_000, annualRate: "0.281" };

describe("monthlyRatePpb", () => {
  it("is the effective twelfth root of the annual rate, not a twelfth of it", () => {
    // 1.281^(1/12) - 1 = 2,0851 %, where 28,1 % / 12 would be 2,3417 %.
    assert.equal(monthlyRatePpb("0.281"), 20_851_162);
  });

  it("is zero for no rate", () => {
    assert.equal(monthlyRatePpb("0"), 0);
    assert.equal(monthlyRatePpb("0.0000"), 0);
  });
});

describe("monthlyInterestCents", () => {
  it("strikes one month's interest on what is pending, in whole cents", () => {
    // 471.000.000 cents at 2,0851162 %, by hand: 9.820.897 cents, 98.209 pesos.
    assert.equal(monthlyInterestCents(extension), 9_820_897);
  });

  it("is zero at no rate", () => {
    assert.equal(monthlyInterestCents({ pendingBalanceCents: 100_000, annualRate: "0" }), 0);
  });
});

describe("remainingInterestCents", () => {
  it("is the sum of the interest on a pending that shrinks by one instalment's principal a month", () => {
    const share = Math.ceil(804_500_000 / 24);
    let balance = 471_000_000;
    let expected = 0;
    const step = Number(monthlyRatePpb("0.281")) / 1e9;
    while (balance > 0) {
      expected += Math.round(balance * step);
      balance -= share;
    }
    // The same walk in floating point lands within a cent a month of the integer one.
    assert.ok(Math.abs(remainingInterestCents(extension) - expected) <= 16, `${remainingInterestCents(extension)} vs ${expected}`);
  });

  it("costs nothing at no rate and nothing once nothing is pending", () => {
    assert.equal(remainingInterestCents({ ...extension, annualRate: "0" }), 0);
    assert.equal(remainingInterestCents({ ...extension, pendingBalanceCents: 0 }), 0);
  });

  it("is a fresh purchase's whole cost: a 36-instalment purchase at 28 %", () => {
    const fresh = { originalAmountCents: 100_000_00, instalments: 36, pendingBalanceCents: 100_000_00, annualRate: "0.28" };
    const cost = remainingInterestCents(fresh);
    assert.ok(cost > 0 && cost < 100_000_00);
    assert.equal(deferralCost(fresh).savingsCents, cost);
  });
});

describe("chargesInterest", () => {
  it("needs more than one instalment, a rate above zero and a balance pending", () => {
    assert.equal(chargesInterest(extension), true);
    assert.equal(chargesInterest({ ...extension, instalments: 1 }), false);
    assert.equal(chargesInterest({ ...extension, annualRate: "0" }), false);
    assert.equal(chargesInterest({ ...extension, pendingBalanceCents: 0 }), false);
  });
});
