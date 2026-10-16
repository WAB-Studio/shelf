const DAYS_IN_WEEK = 7;

/** A week or more reads in weeks, rounded to the nearest, never fewer than one; under a week reads in days. */
export function movedSpan(days: number): { short: boolean; weeks: number } {
  return { short: days < DAYS_IN_WEEK, weeks: Math.max(1, Math.round(days / DAYS_IN_WEEK)) };
}
