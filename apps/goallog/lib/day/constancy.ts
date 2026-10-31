import type { EvidenceDay } from "@/lib/day/types";
import { addDaysToCivilDate } from "@/lib/zone";

// Constancy is a strip of the last thirty days and a count of the days done;
// it carries no streak and never says one broke (docs/goallog/DESIGN.md,
// «Decisión del 2026-10-31»).
export const STRIP_DAYS = 30;

// A day a commitment was done, with what it counted: a declared quantity, a
// source's minutes, or nothing for a tap.
export type DoneDay = { day: string; quantity: number | null; by: "declared" | "evidence" };

// `declared` and `evidence` are both days done; the strip tells them apart as the marks do (RP-09).
export type StripCell = { day: string; state: "declared" | "evidence" | "open" | "before" };

// The thirty days ending on `today`, oldest first.
export function stripDays(today: string): string[] {
  return Array.from({ length: STRIP_DAYS }, (_, index) => addDaysToCivilDate(today, index - (STRIP_DAYS - 1)));
}

// Each of the thirty days is done, still open, or before the commitment was
// written (it asked nothing then, so it is neither).
export function strip(today: string, createdOn: string, done: readonly Pick<DoneDay, "day" | "by">[]): StripCell[] {
  const doneBy = new Map(done.map((entry) => [entry.day, entry.by]));
  return stripDays(today).map((day) => ({
    day,
    state: doneBy.get(day) ?? (day < createdOn ? "before" : "open"),
  }));
}

// «26 de 30»: the days done inside the strip over the days it could have been.
export function stripCount(cells: readonly StripCell[]): { done: number; of: number } {
  return {
    done: cells.filter((cell) => cell.state === "declared" || cell.state === "evidence").length,
    of: cells.filter((cell) => cell.state !== "before").length,
  };
}

// The days an evidence source met the commitment's threshold. A day below it
// is a day the source saw something, not a day done.
export function evidenceDoneDays(
  source: { sourceKey: string | null; threshold: number },
  bySourceKey: Record<string, EvidenceDay[]>,
): DoneDay[] {
  if (source.sourceKey === null) return [];
  return (bySourceKey[source.sourceKey] ?? [])
    .filter((entry) => entry.quantity >= source.threshold)
    .map((entry) => ({ day: entry.day, quantity: entry.quantity, by: "evidence" as const }));
}

// Declared and evidence days of one commitment, one entry a day, newest first.
export function mergeDoneDays(declared: readonly DoneDay[], evidence: readonly DoneDay[]): DoneDay[] {
  const byDay = new Map<string, DoneDay>();
  for (const entry of [...evidence, ...declared]) byDay.set(entry.day, entry);
  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}
