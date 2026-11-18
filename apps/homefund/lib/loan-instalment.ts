// How a loan's instalment splits into the interest it pays and the capital it brings down (RF-282). Every figure is
// an integer number of cents; the interest is cut down to the cent and the remainder lands on the capital.

export type InstalmentBasis = "schedule" | "rate" | "none";

export type InstalmentSplit = { interestCents: number; capitalCents: number; basis: InstalmentBasis };

// The bank's printed row for the cuota being paid: what is not capital in it, and how much of that earlier payments
// toward the same cuota already covered.
export type ScheduleShare = { interestCents: number; insuranceCents: number; paidInterestCents?: number };

/**
 * The interest a balance accrues over `days` at an effective annual rate: owed times ((1 + rate)^(days/365) - 1),
 * cut down to the cent. `annualRate` is the stored fraction as text («0.1650»).
 */
export function accruedInterestCents(owedCents: number, annualRate: string, days: number): number {
  const rate = Number(annualRate);
  if (!Number.isFinite(rate) || rate <= 0 || owedCents <= 0 || days <= 0) return 0;
  return Math.floor(owedCents * (Math.pow(1 + rate, days / 365) - 1));
}

/**
 * The split of a payment. A schedule row's own interest and insurance, less what an earlier part-payment of the same
 * cuota already covered, win; else the stored rate over the days since the last payment; else nothing is known and
 * everything is capital. The interest never exceeds the payment, so a payment above the cuota is extra capital.
 */
export function splitInstalment({
  amountCents,
  owedCents,
  annualRate,
  days,
  row,
}: {
  amountCents: number;
  owedCents: number;
  annualRate: string | null;
  days: number;
  row: ScheduleShare | null;
}): InstalmentSplit {
  const interestOf = (basis: InstalmentBasis, interest: number): InstalmentSplit => {
    const interestCents = Math.min(amountCents, Math.max(0, interest));
    return { interestCents, capitalCents: amountCents - interestCents, basis };
  };

  if (row !== null) return interestOf("schedule", row.interestCents + row.insuranceCents - (row.paidInterestCents ?? 0));
  if (annualRate !== null) return interestOf("rate", accruedInterestCents(owedCents, annualRate, days));
  return { interestCents: 0, capitalCents: amountCents, basis: "none" };
}
