import { weekOf } from "@/lib/zone";
import type { Cadence, DeclaredFact } from "./types";

// Distinct days, up to and including `day`, on which the commitment has a
// fact inside the period `day` sits in: its week for `times_per_week`, its
// month for `times_per_month`. Null for a cadence counted by the day. The
// day's own fact counts, unlike `asksOn`'s quota, which reads what came before.
export function periodDoneOn(
  cadence: Cadence,
  commitmentId: string,
  facts: DeclaredFact[],
  day: string,
): number | null {
  let inPeriod: (factDay: string) => boolean;
  if (cadence.kind === "times_per_week") {
    const week = weekOf(day);
    inPeriod = (factDay) => week.includes(factDay);
  } else if (cadence.kind === "times_per_month") {
    const month = day.slice(0, 7);
    inPeriod = (factDay) => factDay.slice(0, 7) === month;
  } else {
    return null;
  }

  const days = new Set<string>();
  for (const fact of facts) {
    if (fact.commitmentId === commitmentId && fact.day <= day && inPeriod(fact.day)) days.add(fact.day);
  }
  return days.size;
}
