// What a deferred purchase reads as today (RF-136). Nothing here is stored: the whole amount is already
// in the balance, and the instalment only fractions that line's share of the minimum payment.

export const MIN_INSTALMENTS = 2;
export const MAX_INSTALMENTS = 72;

export type DeferralStatus =
  | { state: "running"; current: number; total: number; shareCents: number }
  | { state: "extinguished" };

// The share of instalment `k` of `total`: whole cents, the last one taking what the division left.
export function instalmentShareCents(amountCents: number, total: number, k: number): number {
  const base = Math.floor(amountCents / total);
  return k >= total ? amountCents - base * (total - 1) : base;
}

// Calendar months from the purchase's month to `today`'s, both `YYYY-MM-DD` Bogotá dates.
function monthsBetween(from: string, to: string): number {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
}

/**
 * `clearedOn` is the first day on or after the purchase when the account's derived balance reached
 * zero or credit — a payment that covered the balance — or null while it never did. The purchase's
 * own month is instalment 1; the plan ends without penalty past the last one or once cleared.
 */
export function deferralStatus(args: {
  amountCents: number;
  instalments: number;
  purchasedOn: string;
  today: string;
  clearedOn: string | null;
}): DeferralStatus {
  const current = monthsBetween(args.purchasedOn, args.today) + 1;
  if (args.clearedOn !== null || current > args.instalments) return { state: "extinguished" };
  return {
    state: "running",
    current: Math.max(1, current),
    total: args.instalments,
    shareCents: instalmentShareCents(args.amountCents, args.instalments, current),
  };
}
