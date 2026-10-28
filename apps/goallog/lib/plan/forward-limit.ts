import { dayBefore } from "@/lib/day/weeks";
import { weekOf } from "@/lib/zone";

import { monthOf, nextMonth } from "./months";

// A goal with no end reaches this many months past the current one.
const ENDLESS_LIMIT_MONTHS = 12;

function monthsAfter(month: string, count: number): string {
  let last = month;
  for (let i = 0; i < count; i += 1) last = nextMonth(last);
  return last;
}

// "YYYY-MM" of the last month «Mes» and «Semana» step forward to: the last
// month of the furthest open goal's span. A goal with no end counts twelve
// months from today, no open goal leaves this month (RP-142). A goal whose
// horizon is today or before has ended and stretches nothing.
export function forwardLimit({ horizons, today }: { horizons: (string | null)[]; today: string }): string {
  let limit = monthOf(today);
  for (const horizon of horizons) {
    if (horizon !== null && horizon <= today) continue;
    const last = horizon === null ? monthsAfter(monthOf(today), ENDLESS_LIMIT_MONTHS) : monthOf(dayBefore(horizon));
    if (last > limit) limit = last;
  }
  return limit.slice(0, 7);
}

// The Monday of the week holding the limit month's last day: the last week
// «Semana» steps forward to.
export function lastMondayOf(limit: string): string {
  return weekOf(dayBefore(nextMonth(`${limit}-01`)))[0];
}
