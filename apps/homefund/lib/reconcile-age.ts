import { civilDateToDate } from "@/lib/dates";

// A count older than this is worth a nudge (RF-254).
export const STALE_AFTER_DAYS = 30;

const DAY_MS = 86_400_000;

// Whole civil days from `from` to `to`; the midday-UTC dates `civilDateToDate` builds make it exact.
export function daysBetween(from: string, to: string): number {
  return Math.round((civilDateToDate(to).getTime() - civilDateToDate(from).getTime()) / DAY_MS);
}

/**
 * How long an account has gone uncounted: the days since its latest reconciliation, or, for one never
 * counted, since it was added. `never` says which, so a sentence can tell them apart.
 */
export function reconcileAge(
  account: { latestReconciledOn: string | null; addedOn: string },
  today: string,
): { days: number; never: boolean } {
  const never = account.latestReconciledOn === null;
  return { days: Math.max(0, daysBetween(account.latestReconciledOn ?? account.addedOn, today)), never };
}

export function isStale(
  account: { latestReconciledOn: string | null; addedOn: string },
  today: string,
): boolean {
  return reconcileAge(account, today).days > STALE_AFTER_DAYS;
}
