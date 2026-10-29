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
