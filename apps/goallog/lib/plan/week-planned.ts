import { dayBefore } from "@/lib/day/weeks";
import { daysInMonth, type MonthBudget } from "@/lib/plan/months";
import { civilDateToDate, dateToCivilDate } from "@/lib/zone";

/**
 * RP-58: each month's planned amount spread evenly over the month's days,
 * summed over the week's days inside the goal. `horizon` is the first day
 * after the goal. A month with no amount of its own takes `rhythm`. `null` when no such day has an amount above 0.
 */
export function weekPlanned(input: {
  weekStart: string;
  weekEnd: string;
  budgets: MonthBudget[];
  openedOn: string;
  horizon: string | null;
  rhythm?: number | null;
}): number | null {
  const amounts = new Map(input.budgets.map((b) => [b.month, b.amount]));
  const last = input.horizon === null ? null : dayBefore(input.horizon);
  const from = input.weekStart > input.openedOn ? input.weekStart : input.openedOn;
  const to = last !== null && last < input.weekEnd ? last : input.weekEnd;
  // lcm(28, 29, 30, 31): every month length divides it, so each day's share is an exact integer.
  const scale = 377580;
  let scaled = 0;
  let counted = false;
  const cursor = civilDateToDate(from);
  for (let day = from; day <= to; ) {
    const amount = amounts.get(`${day.slice(0, 7)}-01`) ?? input.rhythm ?? 0;
    if (amount > 0) {
      counted = true;
      scaled += amount * (scale / daysInMonth(day));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    day = dateToCivilDate(cursor);
  }
  return counted ? Math.floor(scaled / scale) : null;
}
