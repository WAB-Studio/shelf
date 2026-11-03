import { weekOf } from "@/lib/zone";
import { metDays } from "./met";
import type { CommitmentPlan, DeclaredFact } from "./types";

// Distinct days, up to and including `day`, on which the commitment was met
// inside the period `day` sits in: its week for `times_per_week`, its month
// for `times_per_month`. Null for a cadence counted by the day. The day's own
// fact counts, unlike `asksOn`'s quota, which reads what came before. A short
// quantity day is «en parte» and not one of the period's times (RP-148).
export function periodDoneOn(
  plan: Pick<CommitmentPlan, "id" | "cadence" | "satisfiedBy">,
  facts: DeclaredFact[],
  day: string,
): number | null {
  const { cadence } = plan;
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
  return metDays(plan, facts, (factDay) => factDay <= day && inPeriod(factDay)).size;
}
