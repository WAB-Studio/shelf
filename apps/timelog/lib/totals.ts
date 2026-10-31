import type { DayTotal } from "@/lib/queries";
import { addDays } from "@/lib/zone";

export const sum = (rows: { seconds: number }[]) => rows.reduce((total, row) => total + row.seconds, 0);

// Every day from `from` to `to`, a day with nothing at zero.
export function fill(from: string, to: string, totals: DayTotal[]): DayTotal[] {
  const secondsOn = new Map(totals.map((total) => [total.day, total.seconds]));
  const days: DayTotal[] = [];
  for (let one = from; one <= to; one = addDays(one, 1)) days.push({ day: one, seconds: secondsOn.get(one) ?? 0 });
  return days;
}

// `part` as a whole percent of `whole`, never over 100: two sources counted at once can pass the day they sit in.
export function percent(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.min(100, Math.round((part / whole) * 100));
}
