import { measureOf } from "@/lib/day/derive";
import { dayBefore } from "@/lib/day/weeks";
import type { DeclaredFact, EvidenceDay } from "@/lib/day/types";

export type MonthBudget = { month: string; amount: number };

export type MonthLine = { planned: number | null; reached: number; underPace: boolean };

export type MonthRow = {
  month: string;
  planned: number | null;
  reached: number;
  current: boolean;
  past: boolean;
};

// RP-29 speaks from the 20th on.
const PACE_FROM_DAY = 20;

// "YYYY-MM-01" of the month `day` sits in.
export function monthOf(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

// "YYYY-MM-01" of the month after `month`.
export function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return index === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(index + 1).padStart(2, "0")}-01`;
}

// The horizon is the first day after the goal, so its own month holds no day
// of the goal when it falls on the 1st: the last month is the last day's.
export function monthsOfSpan(openedOn: string, horizon: string): string[] {
  const last = monthOf(dayBefore(horizon));
  const months: string[] = [];
  for (let month = monthOf(openedOn); month <= last; month = nextMonth(month)) {
    months.push(month);
  }
  return months;
}

// `measureOf`'s unit rule (RP-14) per calendar month, over facts and evidence.
// A month with nothing is absent from the map, and a null unit reads empty.
export function reachedByMonth(input: {
  unit: string | null;
  facts: DeclaredFact[];
  evidence: EvidenceDay[];
}): Map<string, number> {
  const { unit, facts, evidence } = input;
  const reached = new Map<string, number>();
  if (unit === null) return reached;

  const factsByMonth = new Map<string, DeclaredFact[]>();
  for (const fact of facts) {
    const month = monthOf(fact.day);
    factsByMonth.set(month, [...(factsByMonth.get(month) ?? []), fact]);
  }
  for (const [month, inMonth] of factsByMonth) {
    reached.set(month, measureOf(unit, inMonth));
  }
  for (const day of evidence) {
    if (day.unit !== unit) continue;
    const month = monthOf(day.day);
    reached.set(month, (reached.get(month) ?? 0) + day.quantity);
  }
  return reached;
}

// Under 60 % is `reached * 5 < planned * 3`: integers only, so 432 of 720
// sits exactly on the line and is not under it. RP-29 states it.
function underSixty(reached: number, planned: number): boolean {
  return reached * 5 < planned * 3;
}

export function monthLine(input: {
  month: string;
  today: string;
  budget: MonthBudget | null;
  reached: number;
  rhythm?: number | null;
}): MonthLine {
  const { month, today, budget, reached, rhythm } = input;
  const planned = budget?.amount ?? rhythm ?? null;
  const underPace =
    month === monthOf(today) &&
    Number(today.slice(8, 10)) >= PACE_FROM_DAY &&
    planned !== null &&
    planned > 0 &&
    underSixty(reached, planned);
  return { planned, reached, underPace };
}

// Every month of the span, a month with nothing included (RP-16). A month
// with no budget of its own plans the goal's rhythm (RP-50).
export function monthRows(input: {
  openedOn: string;
  horizon: string;
  today: string;
  budgets: MonthBudget[];
  reached: Map<string, number>;
  rhythm?: number | null;
}): MonthRow[] {
  const { openedOn, horizon, today, budgets, reached, rhythm } = input;
  const thisMonth = monthOf(today);
  return monthsOfSpan(openedOn, horizon).map((month) => ({
    month,
    planned: budgets.find((budget) => budget.month === month)?.amount ?? rhythm ?? null,
    reached: reached.get(month) ?? 0,
    current: month === thisMonth,
    past: month < thisMonth,
  }));
}

// After a goal's end nothing of it is «en curso»: its last month reads as closed.
export function settledMonths<T extends { current: boolean; past: boolean }>(rows: T[], ended: boolean): T[] {
  return ended ? rows.map((row) => ({ ...row, current: false, past: true })) : rows;
}

// The sum through the current month; a month with no amount plans 0.
export function toDate(rows: MonthRow[]): { planned: number; reached: number } {
  return rows
    .filter((row) => row.current || row.past)
    .reduce(
      (sum, row) => ({
        planned: sum.planned + (row.planned ?? 0),
        reached: sum.reached + row.reached,
      }),
      { planned: 0, reached: 0 },
    );
}
