import type { ReviewWeek } from "@/lib/day/types";

import { shortMonth } from "@/lib/dates/short-month";

import type { GoalReport } from "./report";

export type Section = "month" | "toDate" | "commitments" | "phases" | "tasks" | "months";

// A goal with no unit measures nothing, so it prints no figure section
// rather than a zero (RP-49). `month` stays with a unit even when this month
// has no amount: the page then prints the reached figure alone. `tasks` is
// every task of the month, carried first, so a goal with none prints no head.
// `commitments` follows the measure and prints only with a live one (RP-124).
// A goal that measures nothing prints «months» only when a row it would print
// holds a task, a planned amount or something reached (RP-124); a report that
// carries no task count at all (hand-built) has nothing to say about them.
export function goalSections(goal: GoalReport): Section[] {
  const measured = goal.unit !== null;
  const sections: Section[] = [];
  if (measured) sections.push("month", "toDate");
  if ((goal.commitments ?? []).length > 0) sections.push("commitments");
  if (goal.phases.length > 0) sections.push("phases");
  if (goal.tasks.length > 0) sections.push("tasks");
  if (measured || goal.months.some((month) => holdsSomething(month, goal.unit))) {
    sections.push("months");
  }
  return sections;
}

function holdsSomething(month: GoalReport["months"][number], unit: string | null): boolean {
  const count = month.taskCount ?? month.tasks?.total;
  if (count === undefined || !printsOnPaper(month, unit)) return false;
  return count > 0 || month.planned !== null || month.reached > 0;
}

// A goal's head stays with its table when the table is tall and still short enough for the goal to fit a page.
// A goal taller than a page still breaks, where the printer finds room.
export function keepsHeadWithTable(months: GoalReport["months"], unit: string | null): boolean {
  const rows = months.filter((month) => printsOnPaper(month, unit)).length;
  return rows >= HEAD_WITH_TABLE_ROWS && rows < HEAD_WITH_TABLE_MAX_ROWS;
}

// A month that has not started prints only with a planned amount (a planned 0
// counts, RP-70); a goal that measures nothing (`unit` null) prints one with a
// task too (RP-71). A past or current month always prints, and so does the
// month after the current one when the caller marks it `next`.
export function printsOnPaper(month: GoalReport["months"][number], unit: string | null, next = false): boolean {
  if (next) return true;
  const held = unit === null && (month.tasks?.total ?? 0) > 0;
  return month.past || month.current || month.planned !== null || held;
}

// A whole table this tall is what a head left at a page foot leaves alone on
// the next page; a shorter one is left to flow with its goal.
export const HEAD_WITH_TABLE_ROWS = 8;

// Past this many rows a table is too long for its goal to keep to one page.
export const HEAD_WITH_TABLE_MAX_ROWS = 20;

// A «por mes» table tall enough to keep its goal's head flows across pages between its rows,
// so a goal that does not fit a page never leaves its head alone (`PapelCabeceraPegada.dc.html`).
// A shorter one keeps to one page.
export function isLongTable(months: GoalReport["months"], unit: string | null): boolean {
  return months.filter((month) => printsOnPaper(month, unit)).length >= HEAD_WITH_TABLE_ROWS;
}

// A week as one month holds it: the whole week, or its days in that month.
export type MonthWeek = Pick<ReviewWeek, "index" | "startsOn" | "endsOn" | "total" | "current">;

export type MonthWithWeeks = {
  month: GoalReport["months"][number];
  weeks: MonthWeek[];
};

// A week inside one month sits under it whole; one crossing two sits under
// both, cut at the edge (`goal.weekSplits`), so a month's weeks add up to it.
export function monthsWithWeeks(goal: GoalReport): MonthWithWeeks[] {
  return goal.months.map((month) => {
    const key = month.month.slice(0, 7);
    const weeks: MonthWeek[] = [];
    for (const week of goal.weeks) {
      const parts = goal.weekSplits.filter((split) => split.index === week.index);
      if (parts.length === 0) {
        if (week.startsOn.slice(0, 7) === key) weeks.push(week);
        continue;
      }
      const part = parts.find((split) => split.month.slice(0, 7) === key);
      if (part) weeks.push({ ...week, startsOn: part.startsOn, endsOn: part.endsOn, total: part.total });
    }
    return { month, weeks };
  });
}

// «31 ago–6 sep 2026»: the year closes the span, and opens both ends when the
// span crosses a year.
export function civilSpan(startsOn: string, endsOn: string): string {
  const [startYear, startMonth, startDay] = startsOn.split("-").map(Number);
  const [endYear, endMonth, endDay] = endsOn.split("-").map(Number);
  if (startsOn === endsOn) return `${endDay} ${shortMonth(endsOn)} ${endYear}`;
  const start = shortMonth(startsOn);
  const end = shortMonth(endsOn);
  if (startYear !== endYear) return `${startDay} ${start} ${startYear}–${endDay} ${end} ${endYear}`;
  if (startMonth !== endMonth) return `${startDay} ${start}–${endDay} ${end} ${endYear}`;
  return `${startDay}–${endDay} ${end} ${endYear}`;
}
