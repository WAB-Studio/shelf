import { asksOn } from "@/lib/day/cadence";
import type { Cadence, EvidenceDay, SatisfiedBy } from "@/lib/day/types";
import { addDaysToCivilDate } from "@/lib/zone";

// Constancy is a strip of the last thirty days and a count of the days done;
// it carries no streak and never says one broke (docs/goallog/DESIGN.md,
// «Decisión del 2026-10-31»).
export const STRIP_DAYS = 30;

// A day a commitment was met, with what it counted: a declared quantity, a
// source's minutes, or nothing for a tap. `partial` is a quantity written
// short of its target: a day touched, never a day done.
export type DoneDay = { day: string; quantity: number | null; by: "declared" | "evidence" | "partial"; note?: string | null };

// `neutral` is a day the cadence does not ask on: neither done nor open.
export type StripCell = { day: string; state: "declared" | "evidence" | "partial" | "open" | "neutral" | "before" };

// The thirty days ending on `today`, oldest first.
export function stripDays(today: string): string[] {
  return Array.from({ length: STRIP_DAYS }, (_, index) => addDaysToCivilDate(today, index - (STRIP_DAYS - 1)));
}

// The days of a commitment's own: what a person declared, from the facts that name it. A tap is met by any
// fact; a quantity only once the day's sum reaches its target, as `tally.ts` counts it.
export function declaredDays(
  facts: readonly { day: string; quantity: number | null; note?: string | null }[],
  satisfiedBy: SatisfiedBy,
): DoneDay[] {
  const byDay = new Map<string, number | null>();
  for (const fact of facts) {
    const known = byDay.get(fact.day);
    byDay.set(fact.day, fact.quantity === null ? (known ?? null) : (known ?? 0) + fact.quantity);
  }
  const notes = new Map(facts.filter((fact) => fact.note).map((fact) => [fact.day, fact.note as string]));
  return [...byDay].map(([day, quantity]) => ({
    day,
    quantity,
    note: notes.get(day) ?? null,
    by: satisfiedBy.kind === "quantity" && (quantity ?? 0) < satisfiedBy.target ? ("partial" as const) : ("declared" as const),
  }));
}

// The days an evidence source met the commitment's threshold, from the day the commitment was written to
// `today`. A day below the threshold is a day the source saw something, not a day done; a day before the
// commitment existed was never asked.
export function evidenceDoneDays(
  source: { sourceKey: string | null; threshold: number; createdOn: string },
  bySourceKey: Record<string, EvidenceDay[]> | null,
  today: string,
): DoneDay[] {
  if (source.sourceKey === null || bySourceKey === null) return [];
  return (bySourceKey[source.sourceKey] ?? [])
    .filter((entry) => entry.quantity >= source.threshold && entry.day >= source.createdOn && entry.day <= today)
    .map((entry) => ({ day: entry.day, quantity: entry.quantity, by: "evidence" as const }));
}

// What one commitment has done: declared days (the server's own rule for what it refuses), evidence days
// counted apart, and the strip's window of both, one entry a day, newest first. The one place the two merge.
export function commitmentDays(input: {
  satisfiedBy: SatisfiedBy;
  sourceKey: string | null;
  createdOn: string;
  today: string;
  // Distinct days with a fact, over all time.
  declaredDayCount: number;
  // The facts inside the strip's window.
  recent: readonly { day: string; quantity: number | null; note?: string | null }[];
  evidence: Record<string, EvidenceDay[]> | null;
}): { declaredDayCount: number; evidenceDayCount: number; done: DoneDay[] } {
  const { satisfiedBy, today } = input;
  const start = stripDays(today)[0];
  const evidence = evidenceDoneDays(
    { sourceKey: input.sourceKey, threshold: satisfiedBy.kind === "evidence" ? satisfiedBy.threshold : 1, createdOn: input.createdOn },
    satisfiedBy.kind === "evidence" ? input.evidence : null,
    today,
  );
  // A day the source read under the threshold is listed with its minutes, in part; it is no day done and never counts as one.
  const threshold = satisfiedBy.kind === "evidence" ? satisfiedBy.threshold : 1;
  const inPart =
    input.sourceKey !== null && satisfiedBy.kind === "evidence"
      ? (input.evidence?.[input.sourceKey] ?? [])
          .filter((e) => e.quantity > 0 && e.quantity < threshold && e.day >= (start > input.createdOn ? start : input.createdOn) && e.day <= today)
          .map((e) => ({ day: e.day, quantity: e.quantity, by: "partial" as const }))
      : [];
  const byDay = new Map<string, DoneDay>();
  for (const entry of [...inPart, ...evidence.filter((e) => e.day >= start), ...declaredDays(input.recent, satisfiedBy)]) {
    byDay.set(entry.day, entry);
  }
  return {
    declaredDayCount: input.declaredDayCount,
    evidenceDayCount: evidence.length,
    done: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)),
  };
}

// Whether a cadence names its days: daily, weekdays and every N days do; a count by the week or the month
// leaves the choice of day to the person.
export function namesDays(cadence: Cadence): boolean {
  return cadence.kind === "daily" || cadence.kind === "weekdays" || cadence.kind === "every_n_days";
}

// Each of the thirty days is done, partial, still open, neutral (the cadence asked nothing) or before the
// commitment was written. A day done is drawn done wherever it falls.
export function strip(
  today: string,
  commitment: { cadence: Cadence; createdOn: string },
  done: readonly Pick<DoneDay, "day" | "by">[],
): StripCell[] {
  const doneBy = new Map(done.map((entry) => [entry.day, entry.by]));
  const plan = { id: "", cadence: commitment.cadence, satisfiedBy: { kind: "tap" as const }, retiredAt: null, createdOn: commitment.createdOn };
  return stripDays(today).map((day) => {
    const by = doneBy.get(day);
    if (by === "declared" || by === "evidence") return { day, state: by };
    if (day < commitment.createdOn) return { day, state: "before" };
    if (by === "partial") return { day, state: "partial" };
    if (!namesDays(commitment.cadence)) return { day, state: "neutral" };
    return { day, state: asksOn(plan, day, []) ? "open" : "neutral" };
  });
}

// «26 de 30»: the days done over the days the cadence asked, inside the strip. A cadence that names no day
// has no «of»: it counts the days done alone.
export function stripCount(cells: readonly StripCell[], cadence: Cadence): { done: number; of: number | null } {
  const done = cells.filter((cell) => cell.state === "declared" || cell.state === "evidence").length;
  if (!namesDays(cadence)) return { done, of: null };
  // A day done off the cadence is still done: it adds to both sides.
  return { done, of: cells.filter((cell) => cell.state !== "neutral" && cell.state !== "before").length };
}

// How many commitments were met on each day of `from`..`to`: a declared day meets a tap by any fact and a
// quantity by reaching its target; an evidence day meets its commitment's own source at its own threshold, from
// the day it was written. A source no commitment names counts nothing, and a day under a threshold is not met.
export function dayCounts(
  commitments: readonly { id: string; satisfiedBy: SatisfiedBy; sourceKey: string | null; createdOn: string }[],
  facts: readonly { commitment_id: string | null; day: string; quantity: number | null }[],
  bySourceKey: Record<string, EvidenceDay[]> | null,
  from: string,
  to: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (day: string) => {
    if (day >= from && day <= to) counts[day] = (counts[day] ?? 0) + 1;
  };
  for (const commitment of commitments) {
    if (commitment.satisfiedBy.kind === "evidence") {
      for (const entry of evidenceDoneDays(
        { sourceKey: commitment.sourceKey, threshold: commitment.satisfiedBy.threshold, createdOn: commitment.createdOn },
        bySourceKey,
        to,
      )) {
        add(entry.day);
      }
      continue;
    }
    const own = facts.filter((fact) => fact.commitment_id === commitment.id);
    for (const entry of declaredDays(own, commitment.satisfiedBy)) if (entry.by === "declared") add(entry.day);
  }
  return counts;
}
