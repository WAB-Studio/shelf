// Pure reads behind the screens' at-a-glance blocks. Every figure stays an
// integer number of cents; a percentage is derived here and never stored.

export type LimitBudget = {
  id: string;
  limitCents: number;
  spentCents: number;
  currency: string;
};

// The budgets closest to (or past) their limit, fullest first. A budget with no
// limit reads nothing, so it never competes.
export function nearestLimit<T extends LimitBudget>(budgets: T[], count: number): T[] {
  return budgets
    .filter((budget) => budget.limitCents > 0)
    .map((budget) => ({ budget, used: budget.spentCents / budget.limitCents }))
    .sort((a, b) => b.used - a.used)
    .slice(0, count)
    .map(({ budget }) => budget);
}

export type DueDebt = {
  accountId: string;
  currency: string;
  owedCents: number;
  minimumPaymentCents: number | null;
  nextDueDate: string | null;
};

export type NextDebtPayment = {
  accountId: string;
  currency: string;
  amountCents: number;
  date: string;
};

// The earliest payment among the debts that owe something; the one the debts
// screen badges as «próximo pago».
export function nextDebtPayment(rows: DueDebt[]): NextDebtPayment | null {
  let next: NextDebtPayment | null = null;
  for (const row of rows) {
    if (row.nextDueDate === null || row.owedCents <= 0) continue;
    if (next !== null && next.date <= row.nextDueDate) continue;
    next = {
      accountId: row.accountId,
      currency: row.currency,
      amountCents: row.minimumPaymentCents ?? 0,
      date: row.nextDueDate,
    };
  }
  return next;
}

// Whole-percent shares of a total whose sum is exactly 100 (largest remainder),
// so the labels on a stacked bar never add up to 99 or 101. A zero total gives zeros.
export function shares(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return values.map(() => 0);

  const raw = values.map((value) => (value / total) * 100);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest);
  for (const { index } of order) {
    if (left <= 0) break;
    floors[index] += 1;
    left -= 1;
  }
  return floors;
}

// Folds the categories past the first `keep` into one remainder, so a stacked bar
// holds a handful of segments rather than fourteen slivers.
export function topWithRest<T extends { totalCents: number }>(
  rows: T[],
  keep: number,
): { top: T[]; restCents: number } {
  const sorted = [...rows].sort((a, b) => b.totalCents - a.totalCents);
  const top = sorted.slice(0, keep);
  const restCents = sorted.slice(keep).reduce((sum, row) => sum + row.totalCents, 0);
  return { top, restCents };
}

// The mean over the months that moved money; empty months stay out of it so a
// young fund is not averaged down by months it did not exist. Null when none did.
export function averageOfActive(values: number[]): number | null {
  const active = values.filter((value) => value > 0);
  if (active.length === 0) return null;
  return Math.round(active.reduce((sum, value) => sum + value, 0) / active.length);
}

export type DayGroup<T> = { date: string; rows: T[] };

// Rows already in ledger order grouped by their civil date, in the order the
// dates first appear.
export function groupByDay<T extends { occurredAt: string }>(rows: T[]): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.date === row.occurredAt) last.rows.push(row);
    else groups.push({ date: row.occurredAt, rows: [row] });
  }
  return groups;
}
