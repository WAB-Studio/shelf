import { addCivilDays } from "@/lib/dates";

// The days either side of a statement line a booked movement may sit on and still be that purchase: a
// bank posts a day or two after the person bought, and the person books it on either date (RF-259).
export const PURCHASE_DATE_WINDOW_DAYS = 2;

export type StatementPurchase = { occurredOn: string; amountCents: number; currency: string };
export type BookedPurchase = { id: string; occurredOn: string; amountCents: number; currency: string };

// The range of booked movements worth reading to match these lines, or null when there are none.
export function purchaseWindow(purchases: StatementPurchase[]): { from: string; to: string } | null {
  if (purchases.length === 0) return null;
  const days = purchases.map((purchase) => purchase.occurredOn).sort();
  return {
    from: addCivilDays(days[0], -PURCHASE_DATE_WINDOW_DAYS),
    to: addCivilDays(days[days.length - 1], PURCHASE_DATE_WINDOW_DAYS),
  };
}

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * Pairs each statement line with the movement already booked on the account for the same amount and
 * currency within two days of it, the nearest day first. A movement answers one line only, so two equal
 * purchases need two booked movements to both read as booked. Answers the matched id per line, in order,
 * or null for a line nothing booked covers: the new ones.
 */
export function matchPurchases(purchases: StatementPurchase[], booked: BookedPurchase[]): (string | null)[] {
  const taken = new Set<string>();
  return purchases.map((purchase) => {
    let best: { id: string; apart: number } | null = null;
    for (const movement of booked) {
      if (taken.has(movement.id) || movement.amountCents !== purchase.amountCents || movement.currency !== purchase.currency) continue;
      const apart = daysApart(movement.occurredOn, purchase.occurredOn);
      if (apart <= PURCHASE_DATE_WINDOW_DAYS && (best === null || apart < best.apart)) best = { id: movement.id, apart };
    }
    if (best === null) return null;
    taken.add(best.id);
    return best.id;
  });
}
