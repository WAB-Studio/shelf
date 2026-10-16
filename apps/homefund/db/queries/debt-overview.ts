import "server-only";

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { DebtTerms } from "@/db/schema";
import { withUserDb } from "@/db/session";
import type { CurrencyCode } from "@/lib/currency";
import { todayInBogota } from "@/lib/dates";

// What a debt owes in a currency it does not bill in: a purchase abroad the
// issuer has not billed yet (RF-123), which stays in the currency it was spent
// in. It travels beside the figures below and is never added to them (RF-124).
export type DebtPocket = {
  currency: CurrencyCode;
  owedCents: number;
};

export type DebtOverviewRow = {
  accountId: string;
  debtKind: DebtTerms["debtKind"];
  // The currency the debt bills in. The owed, the limit, the available credit,
  // the interest and the minimum below are all read in this one and no other
  // (RF-121): a credit limit is denominated in what the card settles in.
  currency: CurrencyCode;
  owedCents: number;
  creditLimitCents: number | null;
  availableCreditCents: number | null;
  monthlyInterestCents: number;
  // The fraction 0..1 the interest above is charged at, like `minimum_payment_pct`
  // reads: the screen formats it as a percentage and derives nothing.
  monthlyRatePct: number;
  minimumPaymentCents: number | null;
  nextCutOffDate: string | null;
  nextDueDate: string | null;
  dueInstallmentsCents: number;
  // The card's other pockets, in currency order. The screen shows them; no
  // figure above counts them.
  otherOwed: DebtPocket[];
};

// The next date on or after `today` whose day-of-month is `dayCol`, clamped to the
// month length — the SQL twin of `nextDayOfMonthOnOrAfter`. A null day yields null:
// both month candidates come out null and the min over nulls is null.
function nextDayOfMonthOnOrAfterSql(dayCol: SQL, today: string): SQL {
  return sql`(
    select min(cand.d)
    from generate_series(
      date_trunc('month', ${today}::date),
      date_trunc('month', ${today}::date) + interval '1 month',
      interval '1 month'
    ) as mstart
    cross join lateral (
      select case when ${dayCol} is null then null else make_date(
        extract(year from mstart)::int,
        extract(month from mstart)::int,
        least(${dayCol}, extract(day from (mstart + interval '1 month - 1 day'))::int)
      ) end as d
    ) cand
    where cand.d >= ${today}::date
  )`;
}

/**
 * Every liability that carries debt terms with its derived figures in ONE round
 * trip (RF-78, RF-79, RNF-09): owed is the magnitude of the balance derived by
 * `account_balances` FOR THE POCKET THE CARD BILLS IN; the limit rides along for
 * the consolidated sums and available credit nets it against that same pocket
 * (both null with no limit); the monthly interest is the effective twelfth-root
 * step of the annual rate, NOT the linear `rate/12`, and that step rides along as
 * a rate of its own so the screen states the percentage without dividing
 * anything; the minimum is the fixed amount, or a percentage
 * of the owed, or null; and due installments sum the unpaid lines falling on or
 * before the next due date. The cut-off and due dates come from the latest
 * statement's own printed dates when one exists, and from the terms' fixed days
 * otherwise (RF-131) — the same reading `getCurrentStatement` takes, so the list
 * and the detail screen never name different dates for the same debt; due
 * installments still bound themselves to the terms-derived date, since a
 * statement's due date can be missing. No figure is re-summed from a stored
 * balance, and the CALLER folds these rows into the totals — this adds no round
 * trip for them.
 *
 * The view answers one row per account AND currency since `0032`, so every
 * figure above names the settlement currency in its join: unbounded, the join
 * would return the debt once per currency it holds and each of those readings
 * would net a peso limit against a dollar balance. What the card holds in
 * another currency rides along as `otherOwed`, which nothing here adds up
 * (RF-121, RF-124).
 */
export async function getDebtOverview(): Promise<DebtOverviewRow[]> {
  const today = todayInBogota();
  const nextCutOff = nextDayOfMonthOnOrAfterSql(sql`dt.statement_cut_off_day`, today);
  const nextDue = nextDayOfMonthOnOrAfterSql(sql`dt.payment_due_day`, today);

  return withUserDb(async (tx) => {
    const rows = await tx.execute<{
      account_id: string;
      debt_kind: DebtTerms["debtKind"];
      owed_cents: string;
      credit_limit_cents: string | null;
      available_credit_cents: string | null;
      monthly_interest_cents: string;
      monthly_rate_pct: string;
      minimum_payment_cents: string | null;
      next_cut_off_date: string | null;
      next_due_date: string | null;
      due_installments_cents: string;
      currency: string;
      other_owed: { currency: string; owedCents: string }[];
    }>(sql`
      -- ONE pass over the view for both readings a debt takes off it: the pocket
      -- it bills in, and the ones it does not. A correlated subselect for the
      -- second would re-run the whole aggregate once per debt (RNF-09).
      -- Grouped by the account's own key, never the view's column of that name:
      -- the settlement currency is then functionally dependent and reads
      -- unaggregated inside the two filters.
      with pockets as (
        select
          ac.id,
          max(ab.balance_cents) filter (
            where ab.currency = ac.settlement_currency
          ) as settlement_cents,
          coalesce(jsonb_agg(
            jsonb_build_object(
              'currency', ab.currency,
              -- The cast keeps a bigint out of a JSON number.
              'owedCents', abs(ab.balance_cents)::text
            ) order by ab.currency
          ) filter (where ab.currency <> ac.settlement_currency), '[]'::jsonb) as other_owed
        from account_balances ab
        join accounts ac on ac.id = ab.id and ac.kind = 'liability'
        group by ac.id
      )
      select
        dt.account_id,
        dt.debt_kind,
        a.settlement_currency as currency,
        abs(b.settlement_cents) as owed_cents,
        dt.credit_limit_cents,
        case when dt.credit_limit_cents is null then null
          else dt.credit_limit_cents - abs(b.settlement_cents) end as available_credit_cents,
        round(abs(b.settlement_cents) * mr.monthly_rate)::bigint as monthly_interest_cents,
        mr.monthly_rate as monthly_rate_pct,
        case
          when dt.minimum_payment_cents is not null then dt.minimum_payment_cents
          when dt.minimum_payment_pct is not null
            then round(abs(b.settlement_cents) * dt.minimum_payment_pct)::bigint
          else null
        end as minimum_payment_cents,
        coalesce(s.cut_off_date, nc.next_cut_off) as next_cut_off_date,
        coalesce(s.payment_due_date, nd.next_due) as next_due_date,
        coalesce((
          select sum(l.amount_cents)
          from installment_lines l
          join installment_plans p on p.id = l.plan_id
          where p.account_id = dt.account_id
            and l.paid_transaction_id is null
            and nd.next_due is not null
            and l.due_date <= nd.next_due
        ), 0) as due_installments_cents,
        b.other_owed
      from debt_terms dt
      join accounts a on a.id = dt.account_id and a.kind = 'liability'
      join pockets b on b.id = dt.account_id
      -- The latest closed statement's own printed dates, when one exists
      -- (RF-131): the same row getCurrentStatement reads, so the overview and
      -- the detail screen never name different dates for the same debt.
      left join lateral (
        select s.cut_off_date, s.payment_due_date
        from account_statements s
        where s.account_id = dt.account_id
        order by s.cut_off_date desc
        limit 1
      ) s on true
      cross join lateral (select ${nextCutOff} as next_cut_off) nc
      cross join lateral (select ${nextDue} as next_due) nd
      -- One expression for both readings, so the figure and its rate can never
      -- state different months.
      cross join lateral (select power(1 + dt.annual_rate, 1.0/12) - 1 as monthly_rate) mr
      order by a.name
    `);

    return rows.map((row) => ({
      accountId: row.account_id,
      debtKind: row.debt_kind,
      currency: row.currency,
      // A bigint arrives from the driver as a string; the ledger keeps cents a number.
      owedCents: Number(row.owed_cents),
      creditLimitCents:
        row.credit_limit_cents === null ? null : Number(row.credit_limit_cents),
      availableCreditCents:
        row.available_credit_cents === null ? null : Number(row.available_credit_cents),
      monthlyInterestCents: Number(row.monthly_interest_cents),
      monthlyRatePct: Number(row.monthly_rate_pct),
      minimumPaymentCents:
        row.minimum_payment_cents === null ? null : Number(row.minimum_payment_cents),
      nextCutOffDate: row.next_cut_off_date,
      nextDueDate: row.next_due_date,
      dueInstallmentsCents: Number(row.due_installments_cents),
      otherOwed: row.other_owed.map((pocket) => ({
        currency: pocket.currency,
        owedCents: Number(pocket.owedCents),
      })),
    }));
  });
}

export type DebtCreditTotals = {
  currency: CurrencyCode;
  availableCreditCents: number;
  creditLimitCents: number;
};

/**
 * The consolidated credit figures across exactly the liabilities that carry a
 * limit (RF-83, RF-117), ONE SET PER CURRENCY: each one's limit, and each one's
 * limit less the pocket it bills in. A limit is denominated in the currency its
 * card settles in, so two cards billing in different currencies answer two sets
 * and nothing adds them (RF-124). A liability with no limit is skipped, so it
 * neither lifts a summed limit nor drags a summed available down. Folded over the
 * rows `getDebtOverview` already returned, in the pass the caller spends on the
 * other totals — no second round trip, no stored figure, integer cents throughout.
 *
 * The sets come out in currency order, so two calls on the same rows read alike.
 */
export function sumDebtCreditTotals(rows: DebtOverviewRow[]): DebtCreditTotals[] {
  const byCurrency = new Map<CurrencyCode, DebtCreditTotals>();

  for (const row of rows) {
    if (row.creditLimitCents === null) continue;

    const totals = byCurrency.get(row.currency) ?? {
      currency: row.currency,
      availableCreditCents: 0,
      creditLimitCents: 0,
    };

    byCurrency.set(row.currency, {
      currency: row.currency,
      // The statement pairs the two nulls; the fallback only satisfies the type.
      availableCreditCents:
        totals.availableCreditCents + (row.availableCreditCents ?? 0),
      creditLimitCents: totals.creditLimitCents + row.creditLimitCents,
    });
  }

  return [...byCurrency.values()].sort((left, right) =>
    left.currency.localeCompare(right.currency),
  );
}
