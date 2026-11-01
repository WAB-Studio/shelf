import "server-only";

import { sql } from "drizzle-orm";

import { withUserDb } from "@/db/session";
import { BASE_CURRENCY, type CurrencyCode } from "@/lib/currency";
import { lastSixMonthStarts, monthRange } from "@/lib/dates";

export type MonthlyFlow = {
  // The currency the movements were booked in, and the only one these three
  // figures count (RF-124).
  currency: CurrencyCode;
  incomeCents: number;
  expenseCents: number;
  // Income minus expense; «Descuadre» stays out of it (RF-138).
  netCents: number;
  // Every reconciliation adjustment in the window, signed: + into an account, − out of one.
  adjustmentCents: number;
};

export type MonthFlow = {
  monthStart: string;
  currency: CurrencyCode;
  incomeCents: number;
  expenseCents: number;
  adjustmentCents: number;
};

// What a window with no movement reads as. A fund that has not moved yet still
// draws its figures at zero rather than an empty card, and no read exists to say
// which currency they would have been in, so the settlement default answers.
const EMPTY_CURRENCIES: CurrencyCode[] = [BASE_CURRENCY];

/**
 * Income, expense and net for one half-open window, one row per currency, in ONE
 * aggregate read (RF-88, RNF-09). A transfer is never summed (RF-19): only the
 * `income` and `expense` generated kinds feed the two totals, and a reconciliation
 * adjustment — one-legged, so `income` or `expense` by its kind — rides the same
 * scan as its own signed sum, never inside either (RF-138). `currency` joins
 * the `group by` as a HashAggregate over the same tuples — the movement is
 * counted in the currency it happened in and no row adds two of them (RF-124).
 * `occurred_at` is compared as a `YYYY-MM-DD` string against string bounds,
 * never a JS Date. A window with no rows leaves each sum null, which `coalesce`
 * and `Number` carry to 0.
 */
export async function getMonthlyFlow(range: {
  start: string;
  endExclusive: string;
}): Promise<MonthlyFlow[]> {
  return withUserDb(async (tx) => {
    const rows = await tx.execute<{
      currency: string;
      income_cents: string;
      expense_cents: string;
      adjustment_cents: string;
    }>(sql`
      select
        currency,
        coalesce(sum(amount_cents) filter (where kind = 'income' and reconciliation_id is null), 0) as income_cents,
        coalesce(sum(amount_cents) filter (where kind = 'expense' and reconciliation_id is null), 0) as expense_cents,
        coalesce(sum(case when kind = 'income' then amount_cents else -amount_cents end)
          filter (where reconciliation_id is not null), 0) as adjustment_cents
      from transactions
      where occurred_at >= ${range.start} and occurred_at < ${range.endExclusive}
      group by currency
      order by currency
    `);

    if (rows.length === 0) {
      return EMPTY_CURRENCIES.map((currency) => ({
        currency,
        incomeCents: 0,
        expenseCents: 0,
        netCents: 0,
        adjustmentCents: 0,
      }));
    }

    // A bigint sum arrives from the driver as a string; the ledger keeps cents a number.
    return rows.map((row) => {
      const incomeCents = Number(row.income_cents);
      const expenseCents = Number(row.expense_cents);

      return {
        currency: row.currency,
        incomeCents,
        expenseCents,
        netCents: incomeCents - expenseCents,
        adjustmentCents: Number(row.adjustment_cents),
      };
    });
  });
}

/**
 * Six months of income and expense for the trend, one series PER CURRENCY and
 * oldest first inside each, in ONE grouped read — never one round trip per month
 * or per currency (RNF-09). The span runs from the first of `lastSixMonthStarts()`
 * to the month after its last; the query groups by the `YYYY-MM` month key and
 * the currency, and TypeScript projects those groups onto the six known buckets
 * so a month with no movement still renders as zeros. A currency the window never
 * saw gets no series at all, and no series ever mixes two (RF-124).
 * `occurred_at` is a `date`, so the key comes from `to_char`: no text function
 * can read the column.
 */
export async function getSixMonthFlow(endMonthStart?: string): Promise<MonthFlow[]> {
  const monthStarts = lastSixMonthStarts(endMonthStart);
  const sixMonthStart = monthStarts[0];
  const endExclusive = monthRange(monthStarts[monthStarts.length - 1]).endExclusive;

  return withUserDb(async (tx) => {
    const rows = await tx.execute<{
      month_key: string;
      currency: string;
      income_cents: string;
      expense_cents: string;
      adjustment_cents: string;
    }>(sql`
      select
        to_char(occurred_at, 'YYYY-MM') as month_key,
        currency,
        coalesce(sum(amount_cents) filter (where kind = 'income' and reconciliation_id is null), 0) as income_cents,
        coalesce(sum(amount_cents) filter (where kind = 'expense' and reconciliation_id is null), 0) as expense_cents,
        coalesce(sum(case when kind = 'income' then amount_cents else -amount_cents end)
          filter (where reconciliation_id is not null), 0) as adjustment_cents
      from transactions
      where occurred_at >= ${sixMonthStart} and occurred_at < ${endExclusive}
      group by to_char(occurred_at, 'YYYY-MM'), currency
    `);

    const byBucket = new Map(
      rows.map((row) => [`${row.month_key}|${row.currency}`, row]),
    );

    // The currencies the window actually holds, in code order so two renders draw
    // the charts in the same places.
    const currencies = [...new Set(rows.map((row) => row.currency))].sort((a, b) =>
      a.localeCompare(b),
    );

    // A `YYYY-MM-01` start shares its `YYYY-MM` prefix with the grouped key.
    return (currencies.length === 0 ? EMPTY_CURRENCIES : currencies).flatMap(
      (currency) =>
        monthStarts.map((monthStart) => {
          const row = byBucket.get(`${monthStart.slice(0, 7)}|${currency}`);
          return {
            monthStart,
            currency,
            incomeCents: Number(row?.income_cents ?? 0),
            expenseCents: Number(row?.expense_cents ?? 0),
            adjustmentCents: Number(row?.adjustment_cents ?? 0),
          };
        }),
    );
  });
}
