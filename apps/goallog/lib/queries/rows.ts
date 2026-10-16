import "server-only";

import type { EvidenceByCommitment } from "@/lib/day/derive";
import type { Cadence, DeclaredFact, EvidenceDay, Phase, SatisfiedBy } from "@/lib/day/types";
import { civilDateInZone } from "@/lib/zone";

// The columns `toCadence` and `toSatisfiedBy` read, common to every query's
// own `CommitmentRow` — `lib/queries/day.ts` and `lib/queries/week.ts` widen
// it with `goal_id`, `lib/queries/goal.ts` with `source_label_key`, and each
// file's own wider type still satisfies this one structurally.
export type CommitmentRow = {
  id: string;
  name: string;
  cadence_kind: Cadence["kind"];
  cadence_n: number | null;
  cadence_weekdays: number[] | null;
  satisfaction: SatisfiedBy["kind"];
  target_quantity: number | null;
  unit: string | null;
  threshold: number | null;
  retired_at: string | null;
  created_at: string;
  source_key: string | null;
  source_unit: string | null;
  // Only a habit with no goal carries one (RP-88).
  note?: string | null;
};

// The columns `toPhase` reads. `lib/queries/day.ts` widens it with `goal_id`
// for its own `toPhaseInfo`; `toPhase` itself never needs that column.
export type PhaseRow = {
  id: string;
  aim: string;
  starts_on: string;
  ends_on: string;
};

// The columns `toDeclaredFact` reads, common to every query's own `FactRow` —
// `lib/queries/day.ts` widens it with `id`, `lib/queries/week.ts` with
// `one_off_id` and `goal_id`, and each file's own wider row, narrowed to a
// commitment's fact by its own filter, still satisfies this one structurally.
type DeclaredFactRow = {
  commitment_id: string;
  day: string;
  written_at: string;
  quantity: number | null;
  note: string | null;
  commitment_unit: string | null;
};

export function toCadence(row: CommitmentRow): Cadence {
  switch (row.cadence_kind) {
    case "daily":
      return { kind: "daily" };
    case "weekdays":
      return { kind: "weekdays", days: row.cadence_weekdays ?? [] };
    case "times_per_week":
      return { kind: "times_per_week", count: row.cadence_n ?? 0 };
    case "every_n_days":
      // `goals.commitments` has no anchor column: RP-12 (`docs/goallog/
      // SPEC.md`) settles "every N days" to count from `created_at`, read
      // as the person's own civil day, never Postgres's UTC render of the
      // timestamp — `created_at` between 19:00 and 23:59:59 Bogotá already
      // reads as the next UTC day, so slicing that string would anchor a
      // fifth of all commitments one day late and silently shift the whole
      // cadence from the day it was actually set up.
      return {
        kind: "every_n_days",
        n: row.cadence_n ?? 1,
        anchor: civilDateInZone(new Date(row.created_at)),
      };
    case "times_per_month":
      return { kind: "times_per_month", count: row.cadence_n ?? 0 };
  }
}

export function toSatisfiedBy(row: CommitmentRow): SatisfiedBy {
  switch (row.satisfaction) {
    case "tap":
      return { kind: "tap" };
    case "quantity":
      return { kind: "quantity", target: row.target_quantity ?? 0, unit: row.unit ?? "" };
    case "evidence":
      return { kind: "evidence", threshold: row.threshold ?? 1, unit: row.source_unit ?? "" };
  }
}

export function toPhase(row: PhaseRow): Phase {
  return { id: row.id, name: row.aim, startsOn: row.starts_on, endsOn: row.ends_on };
}

export function toDeclaredFact(row: DeclaredFactRow): DeclaredFact {
  return {
    commitmentId: row.commitment_id,
    day: row.day,
    writtenAt: row.written_at,
    quantity: row.quantity,
    unit: row.commitment_unit,
    note: row.note,
  };
}

// Evidence arrives keyed by source, never by commitment (RNP-10: a source
// answers for the person, not for one commitment). This is the one place
// that turns it into the per-commitment map `deriveDay`/`deriveWeek` expect,
// matching each evidence-satisfied commitment to the source it names.
export function toEvidenceByCommitment(
  commitments: CommitmentRow[],
  bySourceKey: Record<string, EvidenceDay[]>,
): EvidenceByCommitment {
  const byCommitment: EvidenceByCommitment = {};

  for (const row of commitments) {
    if (row.satisfaction !== "evidence" || !row.source_key) continue;
    const days = bySourceKey[row.source_key];
    if (days) byCommitment[row.id] = days;
  }

  return byCommitment;
}
