import { addCivilDays, addCivilMonths } from "@/lib/dates";

// A charge of one series on one day, in integer cents.
export type SeriesCharge = { date: string; cents: number };

// What a series that is a subscription says about itself.
export type Subscription = {
  typicalCents: number;
  occurrences: number;
  firstDate: string;
  lastDate: string;
  nextExpected: string;
  active: boolean;
};

// A subscription is one merchant charged about the same amount on a regular monthly cadence (RF-311): at least two
// charges, a median gap of a month, two thirds of the gaps and of the amounts holding steady. Trips of loose amounts
// on loose days, a weekly habit and a shop one goes to often are never one.
const MIN_OCCURRENCES = 2;
const MONTH_GAP_DAYS = { min: 25, max: 35 } as const;
// An amount stays steady within this percent of the series' median, either way.
const AMOUNT_TOLERANCE_PERCENT = 10;
// A subscription is still running while its next charge is at most this many days late.
const GRACE_DAYS = 10;

function daysBetween(from: string, to: string): number {
  let days = 0;
  for (let day = from; day < to; day = addCivilDays(day, 1)) days += 1;
  return days;
}

// The lower median, the one a SQL `percentile_disc(0.5)` answers.
function lowerMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1];
}

/**
 * Reads a merchant's charges, one per day, as a subscription or as nothing. Integer arithmetic throughout: the amount
 * is steady when 100 × cents lies within the tolerance of 100 × the median.
 */
export function readSubscription(charges: SeriesCharge[], today: string): Subscription | null {
  if (charges.length < MIN_OCCURRENCES) return null;
  const ordered = [...charges].sort((a, b) => a.date.localeCompare(b.date));
  const gaps = ordered.slice(1).map((charge, index) => daysBetween(ordered[index].date, charge.date));
  const typicalCents = lowerMedian(ordered.map((charge) => charge.cents));
  const medianGap = lowerMedian(gaps);
  if (medianGap < MONTH_GAP_DAYS.min || medianGap > MONTH_GAP_DAYS.max) return null;

  const steadyGaps = gaps.filter((gap) => gap >= MONTH_GAP_DAYS.min && gap <= MONTH_GAP_DAYS.max).length;
  const low = typicalCents * (100 - AMOUNT_TOLERANCE_PERCENT);
  const high = typicalCents * (100 + AMOUNT_TOLERANCE_PERCENT);
  const steadyAmounts = ordered.filter((charge) => charge.cents * 100 >= low && charge.cents * 100 <= high).length;
  if (3 * steadyGaps < 2 * gaps.length || 3 * steadyAmounts < 2 * ordered.length) return null;

  const lastDate = ordered[ordered.length - 1].date;
  const nextExpected = addCivilMonths(lastDate, 1);
  return {
    typicalCents,
    occurrences: ordered.length,
    firstDate: ordered[0].date,
    lastDate,
    nextExpected,
    active: addCivilDays(nextExpected, GRACE_DAYS) >= today,
  };
}
