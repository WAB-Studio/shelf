import { addDays, isCivilDay } from "@/lib/zone";

// The Monday of `day`'s Monday-to-Sunday week.
export function mondayOf(day: string): string {
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(day, -weekday);
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
export function parseWeek(value: string | undefined, firstDay: string | null, today: string): string {
  const monday = askedWeek(value, today);
  const { first, last } = span(firstDay, today);
  if (monday < first) return first;
  return monday > last ? last : monday;
}
