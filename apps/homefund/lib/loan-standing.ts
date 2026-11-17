import type { LoanScheduleSummary } from "@/lib/loan-schedule";

// What a loan still asks, said once: the figure its screen leads with and every other screen that names «lo que falta»
// reads (RF-287). With the bank's schedule it is what the unpaid cuotas add up to, interest and insurance included; with
// none it is the balance the movements derive, and the count is only as good as the terms it comes from.
export type LoanStanding = {
  owedCents: number;
  // Null when neither a schedule, a term nor an instalment says how many cuotas that is.
  count: number | null;
  source: "schedule" | "term" | "instalment" | "balance";
};

/**
 * `balanceOwedCents` is what the loan owes, from its movements. `paymentCount` is how many payments reached it, read
 * against the term when the loan has one; an instalment alone gives `ceil(owed / instalment)`, which leaves interest out.
 */
export function loanStanding({
  balanceOwedCents,
  schedule,
  termMonths,
  installmentCents,
  paymentCount,
}: {
  balanceOwedCents: number;
  schedule: Pick<LoanScheduleSummary, "remainingTotalCents" | "remainingCount"> | null;
  termMonths: number | null;
  installmentCents: number | null;
  paymentCount: number;
}): LoanStanding {
  if (schedule !== null) {
    return { owedCents: schedule.remainingTotalCents, count: schedule.remainingCount, source: "schedule" };
  }
  if (balanceOwedCents <= 0) return { owedCents: 0, count: 0, source: "balance" };
  if (termMonths !== null) {
    return { owedCents: balanceOwedCents, count: Math.max(1, termMonths - paymentCount), source: "term" };
  }
  if (installmentCents !== null && installmentCents > 0) {
    return { owedCents: balanceOwedCents, count: Math.ceil(balanceOwedCents / installmentCents), source: "instalment" };
  }
  return { owedCents: balanceOwedCents, count: null, source: "balance" };
}

export type Reconciliation = { kind: "same" | "payerAhead" | "personAhead"; cents: number };

/**
 * How what the payer still owes the person sits against what the credit still owes the lender, both capital. They part
 * when one side paid and the other has not yet passed it on: «payerAhead» is money the payer sent that has not reached
 * the lender, «personAhead» a cuota the person paid before the payer sent it.
 */
export function reconcileCredit(creditOwedCents: number, payerOwesCents: number): Reconciliation {
  const gap = creditOwedCents - payerOwesCents;
  if (gap === 0) return { kind: "same", cents: 0 };
  return gap > 0 ? { kind: "payerAhead", cents: gap } : { kind: "personAhead", cents: -gap };
}
