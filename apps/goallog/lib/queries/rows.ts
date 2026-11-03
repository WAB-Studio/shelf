import "server-only";

import { sql, type SQL } from "drizzle-orm";

import type { EvidenceByCommitment } from "@/lib/day/derive";
import type { Cadence, DeclaredFact, EvidenceDay, Phase, SatisfiedBy } from "@/lib/day/types";
import { TIME_UNITS } from "@/lib/units/time";
import { civilDateInZone, TIME_ZONE } from "@/lib/zone";

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
  commitment_id: string | null;
  day: string;
  written_at: string;
  quantity: number | null;
  note: string | null;
  commitment_unit: string | null;
  // Absent where a statement builds its own fact object without it.
  day_target?: number | null;
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

// The unit a fact's quantity is in: its commitment's, or, for a task done in
// minutes (RP-147), its goal's measure. Read in a statement that joins
// `commitments` as `c` and `facts` as `f`.
export const factUnit: SQL = sql`coalesce(c.unit, (
  select fg.measure_unit from "goals"."goals" fg where fg.id = f.goal_id and f.one_off_id is not null
))`;

export { countsInMeasure } from "@/lib/day/measure-inputs";

// The goal's confirmed time (RP-151) as fact-shaped rows, one per allocation, on the entry's day: the measure
// reads them like a commitment's quantity in the goal's own unit. Only goals measured in minutes take any.
// `goalFilter` names the goal in the caller's statement; `bounds` limit the entry's day.
export function confirmedTimeFacts(goalFilter: SQL, bounds?: { from: SQL | string; to: SQL | string }): SQL {
  const range = bounds ? sql`and e.day between ${bounds.from}::date and ${bounds.to}::date` : sql``;
  return sql`(select coalesce(jsonb_agg(jsonb_build_object(
               'id', a.id,
               'commitment_id', null,
               'one_off_id', null,
               'goal_id', a.goal_id,
               'day', e.day,
               'written_at', e.created_at,
               'quantity', a.minutes,
               'note', null,
               'commitment_unit', tg.measure_unit,
               'time_allocation', true
             ) order by e.day, e.created_at, a.id), '[]'::jsonb)
          from "goals"."time_allocations" a
          join "goals"."time_entries" e on e.id = a.entry_id
          join "goals"."goals" tg on tg.id = a.goal_id
          where ${goalFilter} and e.dismissed_at is null
            and coalesce(lower(trim(tg.measure_unit)) = any(array[${sql.join(TIME_UNITS.map((u) => sql`${u}`), sql`, `)}]::text[]), false)
            ${range})`;
}

export function toDeclaredFact(row: DeclaredFactRow): DeclaredFact {
  return {
    // A task's minutes name no commitment: the empty id matches none, and only the measure reads them.
    commitmentId: row.commitment_id ?? "",
    day: row.day,
    writtenAt: row.written_at,
    quantity: row.quantity,
    unit: row.commitment_unit,
    note: row.note,
    dayTarget: row.day_target ?? null,
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

// RP-148 in SQL: a commitment's fact is a day done when the commitment asks no quantity, or when its quantity
// reaches the day's own target, else the commitment's. One fact a commitment a day, so a row decides its day.
// Its twin for facts already read is `dayMet` in lib/day/met.ts.
export function metFact(f: "f", c: "c" | "h"): SQL {
  return sql`(${sql.raw(c)}.satisfaction <> 'quantity' or ${sql.raw(f)}.quantity >= coalesce(${sql.raw(f)}.day_target, ${sql.raw(c)}.target_quantity))`;
}

// A goal a past day still saw: not archived, or archived that day or later (RP-24) — the last day of a closed
// month or week included.
export function livedThrough(alias: "g" | "a", day: string): SQL {
  return sql`(${sql.raw(alias)}.archived_at is null or (${sql.raw(alias)}.archived_at at time zone ${TIME_ZONE})::date >= ${day}::date)`;
}
