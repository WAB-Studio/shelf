import "server-only";

import { claimClientCall } from "@/lib/word/client-budget";

// One caller, across every paid route, may spend this fraction of the day's
// model calls: 1 in 5, in whole calls so no float reaches a cap.
const SHARE_DENOMINATOR = 5;

export function callerShareCap(dailyCap: number): number {
  return Math.max(1, Math.floor(dailyCap / SHARE_DENOMINATOR));
}

// Claimed before a route's own caller claim. `client` is the unscoped key, so
// the text, unlisted, notes and translate routes bump one and the same row.
export async function claimCallerShare(client: string, dailyCap: number): Promise<boolean> {
  return claimClientCall(`share:${client}`, callerShareCap(dailyCap));
}
