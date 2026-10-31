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

// The earliest payment among the debts that owe something: the one the debts screen
// badges as «próximo pago» and Inicio names. `row` is the debt it came from.
export function nextDebtPayment<T extends DueDebt>(
  rows: T[],
): (NextDebtPayment & { row: T }) | null {
  let next: (NextDebtPayment & { row: T }) | null = null;
  for (const row of rows) {
    if (row.nextDueDate === null || row.owedCents <= 0) continue;
    if (next !== null && next.date <= row.nextDueDate) continue;
    next = {
      accountId: row.accountId,
      currency: row.currency,
      amountCents: row.minimumPaymentCents ?? 0,
      date: row.nextDueDate,
      row,
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

/**
 * One running total per currency, in the order the rows introduce them, so a line never
 * adds two currencies together (RF-124). Every row hands over its currency and the
 * figures to run up in it.
 */
export function sumByCurrency<Row>(
  rows: Row[],
  read: (row: Row) => [string, number[]],
): [string, number[]][] {
  const totals = new Map<string, number[]>();

  for (const row of rows) {
    const [currency, figures] = read(row);
    const running = totals.get(currency);
    if (running) figures.forEach((figure, index) => (running[index] += figure));
    else totals.set(currency, [...figures]);
  }

  return [...totals.entries()];
}

export type BudgetTotal = { currency: string; limitCents: number; spentCents: number };

// Limit and spend per currency (RF-124).
export function budgetTotals(rows: LimitBudget[]): BudgetTotal[] {
  return sumByCurrency(rows, (row) => [row.currency, [row.limitCents, row.spentCents]]).map(
    ([currency, [limitCents, spentCents]]) => ({ currency, limitCents, spentCents }),
  );
}

// A day's net per currency: income in, expense out. A transfer moves money between
// the fund's own accounts and a reconciliation adjustment is no spending, so neither
// counts (RF-19, RF-138). Order of first appearance.
export function dayNet(
  rows: { kind: string; currency: string; amountCents: number; reconciliationId: string | null }[],
): [string, number][] {
  const nets = new Map<string, number>();
  for (const row of rows) {
    if (row.reconciliationId !== null) continue;
    if (row.kind !== "income" && row.kind !== "expense") continue;
    const signed = row.kind === "income" ? row.amountCents : -row.amountCents;
    nets.set(row.currency, (nets.get(row.currency) ?? 0) + signed);
  }
  return [...nets];
}

// The chart palette: violets, jade, amber, sky and slate, never red, which a chart
// keeps for what was exceeded.
export const CHART_PALETTE = [
  "#5b2ee5",
  "#2a9d8f",
  "#f0a30a",
  "#8b6cff",
  "#0ea5e9",
  "#64748b",
  "#5eead4",
  "#c084fc",
] as const;

// One category's colour on a chart, the same on every screen and every visit: derived
// from its id, so two categories rarely share one and none turns red.
export function chartColor(key: string): string {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return CHART_PALETTE[hash % CHART_PALETTE.length];
}

// Whether a stored #rrggbb colour reads as red (hue within 20 degrees of it, and
// saturated enough to be one): a chart keeps red for what was exceeded.
export function isRedish(hex: string): boolean {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return false;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(match[1].slice(at, at + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta < 0.2 || max === 0) return false;
  let hue: number;
  if (max === r) hue = ((g - b) / delta + 6) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  const degrees = hue * 60;
  return degrees <= 20 || degrees >= 340;
}

// The colour a category wears on a chart: the one it is stored with, or the palette's
// when it has none or is red.
export function categoryChartColor(stored: string | null, key: string): string {
  return stored && /^#[0-9a-f]{6}$/i.test(stored) && !isRedish(stored) ? stored : chartColor(key);
}
