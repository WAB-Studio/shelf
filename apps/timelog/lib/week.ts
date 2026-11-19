import { appName } from "@/lib/app-names";
import type { DayApp } from "@/lib/queries";
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

// The week's days in whole minutes, floored as each day's own screen floors them, and their total: the sum of those
// minutes, so the seven figures on «Semana» always add up to the one beside them.
export function weekMinutes(seconds: number[]): { minutes: number[]; total: number } {
  const minutes = seconds.map((one) => Math.floor(one / 60));
  return { minutes, total: minutes.reduce((sum, one) => sum + one, 0) };
}

export type WeekApp = { app: string; total: number; perDay: number[] };

// The week's apps under their readable names (two processes with one name add up, Windows' noise is `systemName`),
// longest first, each with its seconds on every one of `days`.
export function appsOfWeek(rows: DayApp[], days: string[], systemName: string): WeekApp[] {
  const byApp = new Map<string, number[]>();
  for (const one of rows) {
    const index = days.indexOf(one.day);
    if (index < 0) continue;
    const name = appName(one.app, systemName);
    const perDay = byApp.get(name) ?? days.map(() => 0);
    perDay[index] += one.seconds;
    byApp.set(name, perDay);
  }
  return [...byApp]
    .map(([app, perDay]) => ({ app, perDay, total: perDay.reduce((sum, one) => sum + one, 0) }))
    .sort((a, b) => b.total - a.total || a.app.localeCompare(b.app));
}
