// What a deferral the issuer prints on a card costs (RF-253). Nothing here is stored: the bank's figures
// are, and a month's interest and what paying it off saves derive from them. Every amount is an integer
// number of cents; the rate is the one non-integer figure, turned into an integer count of parts per
// billion once, before it touches an amount, so no float ever rounds a cent.

const PPB = 1_000_000_000;
const HALF = PPB / 2;

export type DeferralFigures = {
  originalAmountCents: number;
  instalments: number;
  pendingBalanceCents: number;
  // The effective annual fraction as the column stores it, "0.2810".
  annualRate: string;
};

// The effective monthly step of an effective annual rate, in parts per billion: the twelfth root, not rate/12.
export function monthlyRatePpb(annualRate: string): number {
  const annual = Number(annualRate);
  if (!Number.isFinite(annual) || annual <= 0) return 0;
  return Math.round((Math.pow(1 + annual, 1 / 12) - 1) * PPB);
}

// Cents times parts per billion overflows a double on a large balance, so the product runs in BigInt.
function interestOn(balanceCents: number, ratePpb: number): number {
  return Number((BigInt(balanceCents) * BigInt(ratePpb) + BigInt(HALF)) / BigInt(PPB));
}

// One month's interest on what is still pending.
export function monthlyInterestCents(deferral: Pick<DeferralFigures, "pendingBalanceCents" | "annualRate">): number {
  return interestOn(deferral.pendingBalanceCents, monthlyRatePpb(deferral.annualRate));
}

// The principal each instalment pays down: the original amount over the instalments, rounded up so the walk ends.
export function principalShareCents(deferral: Pick<DeferralFigures, "originalAmountCents" | "instalments">): number {
  return Math.max(1, Math.ceil(deferral.originalAmountCents / deferral.instalments));
}

/**
 * The interest still to come if the deferral runs to its end: each month's interest on what is pending, the
 * pending shrinking by one instalment's principal a month. It is also what paying the whole of it today
 * saves, and what a fresh deferral will cost over its life.
 */
export function remainingInterestCents(deferral: DeferralFigures): number {
  const ratePpb = monthlyRatePpb(deferral.annualRate);
  if (ratePpb === 0) return 0;
  const share = principalShareCents(deferral);
  let balance = deferral.pendingBalanceCents;
  let total = 0;
  // Bounded by the 120 instalments the table allows, whatever a bank prints.
  for (let month = 0; balance > 0 && month < 120; month += 1) {
    total += interestOn(balance, ratePpb);
    balance -= share;
  }
  return total;
}

// A deferral that charges interest: more than one instalment, a rate above zero and something still pending.
export function chargesInterest(
  deferral: Pick<DeferralFigures, "instalments" | "pendingBalanceCents" | "annualRate">,
): boolean {
  return deferral.instalments > 1 && deferral.pendingBalanceCents > 0 && monthlyRatePpb(deferral.annualRate) > 0;
}

export type DeferralCost = {
  monthlyInterestCents: number;
  // What paying it off today saves: the interest still to come.
  savingsCents: number;
};

export function deferralCost(deferral: DeferralFigures): DeferralCost {
  return {
    monthlyInterestCents: monthlyInterestCents(deferral),
    savingsCents: remainingInterestCents(deferral),
  };
}
