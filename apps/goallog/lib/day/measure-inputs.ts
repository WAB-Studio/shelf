import type { EvidenceDay } from "@/lib/day/types";

type MeasureSource = {
  satisfaction: string;
  source_key: string | null;
  source_unit: string | null;
};

// The evidence rows that feed a goal's measure in `unit`: only evidence
// commitments whose source is counted in that unit, and one read per source
// key however many commitments name it. Pass the goal's every commitment,
// retired ones included, and the rows the readers returned; an unreadable
// source arrives as an empty map and feeds nothing.
export function evidenceDaysFor(
  unit: string | null,
  commitments: MeasureSource[],
  bySourceKey: Record<string, EvidenceDay[]>,
): EvidenceDay[] {
  if (!unit) return [];
  const keys = new Set(
    commitments
      .filter((c) => c.satisfaction === "evidence" && c.source_key !== null && c.source_unit === unit)
      .map((c) => c.source_key as string),
  );
  const days: EvidenceDay[] = [];
  for (const key of keys) for (const day of bySourceKey[key] ?? []) days.push(day);
  return days;
}

// What a goal's measure reads (RP-14, RP-151): a commitment's fact, or time the person confirmed for the goal.
// A task's own fact says «done» and carries no minutes the measure counts.
export function countsInMeasure(row: { commitment_id: string | null; time_allocation?: boolean }): boolean {
  return row.commitment_id !== null || row.time_allocation === true;
}
