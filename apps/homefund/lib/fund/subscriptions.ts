import type { Cadence } from "@/db/queries/spending-patterns";
import type { CurrencyCode } from "@/lib/currency";
import { sumByCurrency } from "@/lib/fund/glance";

const WEEKS_PER_YEAR = 52;
const MONTHS_PER_YEAR = 12;

// What a repeated charge costs a month, in whole cents: a weekly one is 52 charges over 12 months,
// floored in integer arithmetic so no cent comes from floating point.
export function monthlyCents(charge: { cadence: Cadence; typicalCents: number }): number {
  if (charge.cadence === "monthly") return charge.typicalCents;
  const yearly = charge.typicalCents * WEEKS_PER_YEAR;
  return (yearly - (yearly % MONTHS_PER_YEAR)) / MONTHS_PER_YEAR;
}

// What the charges cost a month, per currency and never summed across currencies.
export function monthlyByCurrency(
  charges: { cadence: Cadence; typicalCents: number; currency: string }[],
): [CurrencyCode, number][] {
  return sumByCurrency(charges, (charge) => [charge.currency, [monthlyCents(charge)]]).map(
    ([currency, [cents]]) => [currency as CurrencyCode, cents],
  );
}
