import { addDays, isCivilDay } from "@/lib/zone";

// Monday 0 to Sunday 6.
export function weekdayIndex(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}

// The Monday of `day`'s Monday-to-Sunday week.
export function mondayOf(day: string): string {
  return addDays(day, -weekdayIndex(day));
}

export function daysOfWeek(monday: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

// The weeks there is something to show. An upload may carry tomorrow, which can open next week:
// the span never starts after this week, or the clamp would bounce between its two ends.
function span(firstDay: string | null, today: string): { first: string; last: string } {
  const last = mondayOf(today);
  const first = mondayOf(firstDay ?? today);
  return { first: first > last ? last : first, last };
}

// ‹ › of a week (RT-05): back to the first upload's week, forward to this one; null where there is none.
export function weekSteps(monday: string, firstDay: string | null, today: string): { prev: string | null; next: string | null } {
  const { first, last } = span(firstDay, today);
  return {
    prev: monday > first ? addDays(monday, -7) : null,
    next: monday < last ? addDays(monday, 7) : null,
  };
}

// `?semana=` as the Monday it names; malformed, this week. Read before the span is known.
export function askedWeek(value: string | undefined, today: string): string {
  return value !== undefined && isCivilDay(value) ? mondayOf(value) : mondayOf(today);
}

// The asked week inside the span: past either end, the nearer end.
export function clampWeek(monday: string, firstDay: string | null, today: string): string {
  const { first, last } = span(firstDay, today);
  if (monday < first) return first;
  return monday > last ? last : monday;
}

export type StripDay = { day: string; reachable: boolean; current: boolean; uploaded: boolean };

// The strip of a day's week (Monday to Sunday): which days there is a screen for (the first upload to today), the
// current one, which of them an upload reached (`uploaded` holds those days), and where ‹ › land: the same weekday a week
// away, held inside the span; null where there is no such week.
export function dayStrip(day: string, firstDay: string | null, today: string, uploaded: ReadonlySet<string>): { monday: string; days: StripDay[]; prev: string | null; next: string | null } {
  const monday = mondayOf(day);
  const first = firstDay ?? today;
  const prev = addDays(day, -7);
  const next = addDays(day, 7);
  return {
    monday,
    days: daysOfWeek(monday).map((one) => ({ day: one, reachable: one >= first && one <= today, current: one === day, uploaded: uploaded.has(one) })),
    prev: monday > mondayOf(first) ? (prev < first ? first : prev) : null,
    next: monday < mondayOf(today) ? (next > today ? today : next) : null,
  };
}
