import { addWeeksToCivilDate, civilDateToDate, dateToCivilDate, weekOf } from "@/lib/zone";

// Whole civil days between two `YYYY-MM-DD` strings, at midday UTC so no
// zone offset can shift the count by one — the one implementation every
// screen that counts a goal's weeks shares (`lib/day/review.ts` and
// `components/goal/phase-weeks.ts` held identical copies of this).
export function daysBetween(from: string, to: string): number {
  const ms = civilDateToDate(to).getTime() - civilDateToDate(from).getTime();
  return Math.round(ms / 86_400_000);
}

function mondayOf(day: string): string {
  return weekOf(day)[0];
}

// The 1-based week `day` falls in, counted Monday to Sunday from the Monday
// of the goal's opening day: week 1 is the partial week from the opening day
// to its first Sunday — the one convention
// every screen that counts a goal's weeks reuses; never a second one.
export function weekIndexOf(openedOn: string, day: string): number {
  return Math.floor(daysBetween(mondayOf(openedOn), mondayOf(day)) / 7) + 1;
}

// A horizon is the first day after the goal: the Monday after its week
// `weeks`, so a goal written «12 semanas» ends on the Sunday of its week 12.
export function horizonForWeeks(openedOn: string, weeks: number): string {
  return addWeeksToCivilDate(mondayOf(openedOn), weeks);
}

// The week the goal's last day falls in. A horizon from `horizonForWeeks`
// reads back as its N; one that falls mid-week counts that partial last week.
// A goal with no end has no weeks: null.
export function horizonWeeksOf(openedOn: string, horizon: string): number;
export function horizonWeeksOf(openedOn: string, horizon: string | null): number | null;
export function horizonWeeksOf(openedOn: string, horizon: string | null): number | null {
  if (horizon === null) return null;
  return horizon <= openedOn ? 0 : weekIndexOf(openedOn, dayBefore(horizon));
}

export function dayBefore(day: string): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() - 1);
  return dateToCivilDate(date);
}

// The inverse of `weekIndexOf`: the civil dates a span of 1-based weeks
// covers. Week 1 opens on `openedOn` itself; a later week opens on its own
// Monday. The span closes on the Sunday of week `toWeek`, or on the goal's
// last day when a `horizon` is given and week `toWeek` is the one holding it;
// a week that opens at or after the horizon keeps its Sunday, so it stays past.
export function weekSpan(
  openedOn: string,
  fromWeek: number,
  toWeek: number,
  horizon?: string | null,
): { startsOn: string; endsOn: string } {
  const firstMonday = mondayOf(openedOn);
  const sunday = dayBefore(addWeeksToCivilDate(firstMonday, toWeek));
  const holdsLastDay = horizon != null && addWeeksToCivilDate(firstMonday, toWeek - 1) < horizon;
  const last = holdsLastDay ? dayBefore(horizon) : sunday;
  return {
    startsOn: fromWeek === 1 ? openedOn : addWeeksToCivilDate(firstMonday, fromWeek - 1),
    endsOn: last < sunday ? last : sunday,
  };
}
