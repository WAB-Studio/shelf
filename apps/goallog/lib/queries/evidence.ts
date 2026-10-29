import "server-only";

import type { SQL } from "drizzle-orm";

import type { EvidenceDay } from "@/lib/day/types";
import { knownSourceKeys, readerFor } from "@/lib/evidence/registry";
import type { Transaction } from "@/lib/session";
import { TIME_ZONE } from "@/lib/zone";

export type EvidenceOutcome = {
  status: "read" | "unreadable";
  bySourceKey: Record<string, EvidenceDay[]>;
};

// One query per known source (today, exactly one), independent of which
// commitments actually reference it: the caller's mapping step narrows the
// result back down to the commitments that asked for it. `from`/`to` are an
// opaque bound — a civil day, or a scalar subquery when the span is not yet
// known in this process.
export async function queryEvidenceBySource(
  tx: Transaction,
  personId: string,
  from: string | SQL,
  to: string | SQL,
): Promise<Record<string, EvidenceDay[]>> {
  const bySourceKey: Record<string, EvidenceDay[]> = {};

  for (const key of knownSourceKeys()) {
    const reader = readerFor(key);
    if (!reader) continue;
    bySourceKey[key] = await reader({ personId, from, to, zone: TIME_ZONE, tx });
  }

  return bySourceKey;
}
