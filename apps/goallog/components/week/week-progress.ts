import { horizonWeeksOf, weekIndexOf } from "@/lib/day/weeks";
import { civilDateInZone, civilDateToDate, dateToCivilDate } from "@/lib/zone";

export type WeekProgress = { week: number; total: number };

/**
 * "Week N of the goal's own horizon" (RP-16's overline, `Semana.dc.html`):
 * `total` is the horizon's own span in goal weeks from the goal's creation,
 * `week` is which of those weeks `weekStart` falls in. Null when the horizon
 * carries no real span (a data problem, not a day to draw a week number for)
 * or when the queried week sits outside it — a goal already past its own
 * horizon draws no overline rather than a number nobody asked for.
 */
export function goalWeekProgress(
  goal: { horizon: string | null; createdAt: string },
  weekStart: string,
): WeekProgress | null {
  const createdCivil = civilDateInZone(new Date(goal.createdAt));
  const total = horizonWeeksOf(createdCivil, goal.horizon);
  if (total === null || total <= 0) return null;

  // The queried week starting before the goal existed floors to week 1.
  const week = Math.max(1, weekIndexOf(createdCivil, weekStart));
  if (week > total) return null;

  return { week, total };
}

/**
 * The goal's last day once it is over: `horizon - 1`, and null while today is
 * still on or before it. The week only draws goals whose horizon is past its
 * Monday, so a returned day never falls before the week.
 */
export function endedLastDay(horizon: string | null, today: string): string | null {
  if (horizon === null || horizon > today) return null;
  const date = civilDateToDate(horizon);
  date.setUTCDate(date.getUTCDate() - 1);
  return dateToCivilDate(date);
}
