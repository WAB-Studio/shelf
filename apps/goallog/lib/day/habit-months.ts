import { civilDateToDate, dateToCivilDate } from "@/lib/zone";
import { nextMonth } from "@/lib/plan/months";
import { asksOn } from "./cadence";
import { habitThisWeek, habitWeeks } from "./habit-weeks";
import type { Cadence, CommitmentPlan } from "./types";

export type HabitMonth = {
  month: string;
  daysDone: number;
  // Null for a cadence counted by the week or the month.
  asked: number | null;
  current: boolean;
  // Weeks met of weeks lived, by the Thursday rule; null unless the cadence is counted by the week.
  weeks: { met: number; counted: number } | null;
  // The week in progress, only in the month of today for a live weekly habit.
  thisWeek: { done: number; count: number } | null;
};

// How many days in `from..to` the plan asks on, by `asksOn` with no facts.
export function askedIn(plan: CommitmentPlan, from: string, to: string): number {
  let asked = 0;
  const cursor = civilDateToDate(from);
  for (let day = from; day <= to; day = dateToCivilDate(cursor)) {
    if (asksOn(plan, day, [])) asked += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return asked;
}

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function monthEnd(month: string): string {
  const date = civilDateToDate(month);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return dateToCivilDate(date);
}

// `retiredOn` is a civil day and clamps the range here; handing it to `asksOn` as `retiredAt` would read it as an instant.
export function habitMonths({
  cadence,
  createdOn,
  retiredOn,
  daysDoneByMonth,
  daysDoneByWeek = new Map(),
  today,
}: {
  cadence: Cadence;
  createdOn: string;
  retiredOn: string | null;
  daysDoneByMonth: Map<string, number>;
  daysDoneByWeek?: Map<string, number>;
  today: string;
}): HabitMonth[] {
  const counted = cadence.kind === "daily" || cadence.kind === "weekdays" || cadence.kind === "every_n_days";
  const plan: CommitmentPlan = { id: "habit-months", cadence, satisfiedBy: { kind: "tap" }, retiredAt: null, createdOn };
  const last = retiredOn !== null && retiredOn < today ? retiredOn : today;
  const lastMonth = monthStart(last);
  const todayMonth = monthStart(today);
  const months: HabitMonth[] = [];
  for (let month = monthStart(createdOn); month <= lastMonth; month = nextMonth(month)) {
    const from = month > createdOn ? month : createdOn;
    const monthTo = monthEnd(month);
    const to = monthTo < last ? monthTo : last;
    months.push({
      month,
      daysDone: daysDoneByMonth.get(month) ?? 0,
      asked: counted ? askedIn(plan, from, to) : null,
      current: month === todayMonth && retiredOn === null,
      weeks:
        cadence.kind === "times_per_week"
          ? habitWeeks({ count: cadence.count, createdOn, retiredOn, daysDoneByWeek, month, today })
          : null,
      thisWeek:
        cadence.kind === "times_per_week" && month === todayMonth
          ? habitThisWeek({ count: cadence.count, retiredOn, daysDoneByWeek, today })
          : null,
    });
  }
  return months;
}
