import { civilDateInZone, civilDateToDate, weekOf } from "@/lib/zone";
import type { CommitmentPlan, DeclaredFact } from "./types";
import { daysBetween } from "./weeks";

// `plan.retiredAt` is the raw ISO instant a `timestamptz` column renders as
// (`retired_at`, read back through `to_jsonb`), never a civil day on its
// own — comparing it bare against a `YYYY-MM-DD` string the way a prior
// version of this file did lexically favoured the session's own UTC render,
// the same defect `lib/queries/day.ts` and `lib/queries/week.ts` carried in
// their own SQL filter. Converted once per instant seen — `deriveWeek` calls
// `asksOn` on the same plan up to seven times, once per day of the week — and
// cached here rather than recomputed on every one of those calls.
const retiredCivilDayCache = new Map<string, string>();

function retiredCivilDay(retiredAt: string): string {
  const cached = retiredCivilDayCache.get(retiredAt);
  if (cached !== undefined) return cached;
  const civilDay = civilDateInZone(new Date(retiredAt));
  retiredCivilDayCache.set(retiredAt, civilDay);
  return civilDay;
}

// ISO 8601: 1 = Monday .. 7 = Sunday, matching `goals.commitments
// .cadence_weekdays` in the database, which is ISO and whose CHECK refuses
// `0`. `Date#getUTCDay` numbers Sunday `0`, so this is the one place in the
// app that turns that into ISO — the only translation between the two
// numbering, so a name only guessed at cannot drift from it.
function weekdayOf(day: string): number {
  const native = civilDateToDate(day).getUTCDay();
  return native === 0 ? 7 : native;
}

// How many of `facts` (for this one commitment) landed on a day that is in
// `period` and strictly before `day`. A quota counts what is already done,
// never the day being asked about — the fact that meets the quota is still
// allowed to land on the day it is being asked for.
function completedBefore(
  commitmentId: string,
  facts: DeclaredFact[],
  day: string,
  inPeriod: (factDay: string) => boolean,
): number {
  const days = new Set<string>();
  for (const fact of facts) {
    if (fact.commitmentId !== commitmentId) continue;
    if (fact.day >= day) continue;
    if (!inPeriod(fact.day)) continue;
    days.add(fact.day);
  }
  return days.size;
}

// Whether `plan` asks for anything on `day`, given the facts recorded for it
// so far. A retired commitment still asks on the civil day it was retired —
// the same day `lib/queries/day.ts`'s and `lib/queries/week.ts`'s own SQL
// filter still admits — and asks nothing on any day after that (RP-13).
export function asksOn(
  plan: CommitmentPlan,
  day: string,
  facts: DeclaredFact[],
): boolean {
  if (day < plan.createdOn) return false;
  if (plan.retiredAt !== null && day > retiredCivilDay(plan.retiredAt)) return false;

  switch (plan.cadence.kind) {
    case "daily":
      return true;

    case "weekdays":
      return plan.cadence.days.includes(weekdayOf(day));

    case "every_n_days": {
      const diff = daysBetween(plan.cadence.anchor, day);
      return diff >= 0 && diff % plan.cadence.n === 0;
    }

    case "times_per_week": {
      const week = weekOf(day);
      const done = completedBefore(plan.id, facts, day, (factDay) =>
        week.includes(factDay),
      );
      return done < plan.cadence.count;
    }

    case "times_per_month": {
      const month = day.slice(0, 7);
      const done = completedBefore(plan.id, facts, day, (factDay) =>
        factDay.slice(0, 7) === month,
      );
      return done < plan.cadence.count;
    }
  }
}
