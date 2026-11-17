import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { hasUsualHistorySql, isAboveUsualSql, usualMedianSql } from "@/db/queries/above-usual";
import { patternKeySql } from "@/db/queries/learned-category";
import { withUserDb } from "@/db/session";
import { monthRange, shiftMonth, todayInBogota } from "@/lib/dates";
import { readSubscription, type SeriesCharge } from "@/lib/fund/subscription-rules";
import { USUAL_WINDOW_MONTHS } from "@/lib/month-review-rules";
import { CATEGORY_PATH_SEPARATOR } from "@/lib/spreadsheet/sheet-layout";

export type Cadence = "monthly" | "weekly";

export type CategorySpending = {
  categoryId: string;
  category: string | null;
  currency: string;
  totalCents: number;
  // Only the months with spending, `YYYY-MM` → cents.
  months: Record<string, number>;
};

export type RecurringCharge = {
  name: string;
  accountId: string;
  accountName: string;
  scope: "personal" | "fund";
  category: string | null;
  currency: string;
  cadence: Cadence;
  typicalCents: number;
  occurrences: number;
  firstDate: string;
  lastDate: string;
  nextExpected: string;
  active: boolean;
};

export type SpendingOutlier = {
  transactionId: string;
  date: string;
  description: string | null;
  accountName: string;
  category: string | null;
  currency: string;
  amountCents: number;
  usualCents: number;
};

export type GrowingCategory = {
  categoryId: string;
  category: string | null;
  currency: string;
  recentMonthlyCents: number;
  baselineMonthlyCents: number;
  changePercent: number;
};

export type SpendingPatterns = {
  today: string;
  fromMonth: string;
  currentMonth: string;
  recentMonths: string[];
  spending: CategorySpending[];
  recurring: RecurringCharge[];
  outliers: SpendingOutlier[];
  growing: GrowingCategory[];
};

// A merchant charged this many times on distinct days is a candidate for a subscription; the rules that settle it are
// `readSubscription`'s (RF-311).
const MIN_OCCURRENCES = 2;
// A category grows when its average over the recent months is over this percent of the months before.
export const GROWTH_PERCENT = 125;
const RECENT_MONTHS = 3;
const MAX_OUTLIERS = 50;

type Window = {
  today: string;
  // How far before the window the above-usual medians read; zero when no outlier is asked for.
  historyMonths: number;
  fromMonth: string;
  currentMonth: string;
  recentFrom: string;
  recentCount: number;
  baselineCount: number;
};

function windowOf(months: number, today: string, historyMonths: number = USUAL_WINDOW_MONTHS): Window {
  const currentMonth = today.slice(0, 7);
  const fromMonth = shiftMonth(currentMonth, -months);
  const recentCount = Math.min(RECENT_MONTHS, Math.floor(months / 2));
  return {
    today,
    historyMonths,
    fromMonth,
    currentMonth,
    recentFrom: shiftMonth(currentMonth, -recentCount),
    recentCount,
    baselineCount: months - recentCount,
  };
}

// Every pattern as one CTE chain over the caller's expenses; RLS scopes each table, so the
// person's own accounts and the fund's they see are read, and no other.
function patternsSql(w: Window): SQL {
  const start = `${w.fromMonth}-01`;
  const { endExclusive } = monthRange(`${w.currentMonth}-01`);
  const historyStart = `${shiftMonth(w.fromMonth, -w.historyMonths)}-01`;
  return sql`
    with tx as materialized (
      select t.id, t.occurred_at, t.amount_cents, t.currency, t.from_account_id, t.description
      from transactions t
      where t.kind = 'expense' and t.reconciliation_id is null
        and t.occurred_at >= ${historyStart}::date and t.occurred_at < ${endExclusive}::date
    ),
    lines as materialized (
      select t.id as transaction_id, t.occurred_at, t.currency, s.category_id, s.amount_cents,
        to_char(t.occurred_at, 'YYYY-MM') as month
      from tx t join transaction_splits s on s.transaction_id = t.id
    ),
    names as (
      select c.id, case when p.id is null then c.name else p.name || ${CATEGORY_PATH_SEPARATOR}::text || c.name end as path
      from categories c left join categories p on p.id = c.parent_id
    ),
    spending as (
      select category_id, currency, month, sum(amount_cents)::bigint as cents
      from lines where occurred_at >= ${start}::date
      group by 1, 2, 3
    ),
    -- One row per series and day. A series is a description without case, accents, digits or
    -- punctuation on one account and currency: «NETFLIX.COM 4412» and «Netflix.com 9921» are one.
    keyed as (
      select t.*, ${patternKeySql(sql`t.description`)} as pattern_key
      from tx t
      where t.occurred_at >= ${start}::date
    ),
    charges as (
      select pattern_key, from_account_id as account_id, currency, occurred_at,
        sum(amount_cents)::bigint as amount_cents,
        (array_agg(id order by amount_cents desc, id))[1] as transaction_id,
        (array_agg(description order by amount_cents desc, id))[1] as description
      from keyed
      where pattern_key is not null
      group by 1, 2, 3, 4
    ),
    -- Every merchant with at least two charges is a candidate; the TypeScript rules decide which are subscriptions.
    series as (
      select pattern_key, account_id, currency,
        (array_agg(description order by occurred_at desc))[1] as description,
        (array_agg(transaction_id order by occurred_at desc))[1] as transaction_id,
        jsonb_agg(jsonb_build_object('date', to_char(occurred_at, 'YYYY-MM-DD'), 'cents', amount_cents) order by occurred_at) as charges
      from charges
      group by 1, 2, 3
      having count(*) >= ${MIN_OCCURRENCES}
    ),
    -- RF-155's «above usual»: a line over three times its category's median in the six months
    -- before its month, once that median rests on three lines.
    cells as (
      select category_id, currency, month,
        to_char(to_date(month, 'YYYY-MM') - make_interval(months => ${USUAL_WINDOW_MONTHS}::int), 'YYYY-MM') as from_month
      from spending
    ),
    usual as (
      select c.category_id, c.currency, c.month,
        ${usualMedianSql(sql`h.amount_cents`)} as median_cents
      from cells c
      join lines h using (category_id, currency)
      where h.month < c.month and h.month >= c.from_month
      group by 1, 2, 3
      having ${hasUsualHistorySql}
    ),
    outliers as (
      select distinct on (l.transaction_id) l.transaction_id, l.occurred_at, l.currency, l.category_id,
        l.amount_cents, u.median_cents
      from lines l
      join usual u using (category_id, currency, month)
      where ${isAboveUsualSql(sql`l.amount_cents`, sql`u.median_cents`)}
      order by l.transaction_id, l.amount_cents desc
    ),
    -- Monthly averages: a month with no spending counts as zero.
    growth as (
      select category_id, currency,
        coalesce(sum(cents) filter (where month >= ${w.recentFrom}), 0)::numeric / nullif(${w.recentCount}::int, 0) as recent,
        coalesce(sum(cents) filter (where month < ${w.recentFrom}), 0)::numeric / ${w.baselineCount}::int as base
      from spending
      where month < ${w.currentMonth}
      group by 1, 2
    )`;
}

type Candidate = {
  name: string;
  accountId: string;
  accountName: string;
  scope: "personal" | "fund";
  category: string | null;
  currency: string;
  charges: SeriesCharge[];
};

// The merchants charged more than once, as JSON; it reads `series` and `names` from `patternsSql`'s chain.
function candidatesJson(): SQL {
  return sql`(select json_agg(json_build_object(
      'name', r.description, 'accountId', r.account_id, 'accountName', a.name,
      'scope', case when a.group_id is null then 'personal' else 'fund' end,
      'category', (select n.path from transaction_splits s join names n on n.id = s.category_id
        where s.transaction_id = r.transaction_id order by s.amount_cents desc, s.id limit 1),
      'currency', r.currency, 'charges', r.charges
    ) order by r.description)
    from series r join accounts a on a.id = r.account_id)`;
}

// The candidates that are subscriptions (RF-311), soonest next charge first.
function subscriptionsOf(candidates: Candidate[] | null, today: string): RecurringCharge[] {
  return (candidates ?? [])
    .flatMap(({ charges, ...candidate }): RecurringCharge[] => {
      const found = readSubscription(charges, today);
      return found === null ? [] : [{ ...candidate, cadence: "monthly", ...found }];
    })
    .sort((a, b) => a.nextExpected.localeCompare(b.nextExpected) || a.name.localeCompare(b.name));
}

/**
 * RF-184's patterns over the last `months` closed months plus the current one: spending by
 * category and month, repeated charges, amounts above usual and growing categories, each per
 * currency and never summed across currencies. One statement, one round trip.
 */
export async function getSpendingPatterns(months: number, today: string = todayInBogota()): Promise<SpendingPatterns> {
  const w = windowOf(months, today);
  return withUserDb(async (tx) => {
    const [row] = await tx.execute<{
      spending: CategorySpending[] | null;
      candidates: Candidate[] | null;
      outliers: SpendingOutlier[] | null;
      growing: GrowingCategory[] | null;
    }>(sql`
      ${patternsSql(w)}
      select
        (select json_agg(json_build_object(
            'categoryId', s.category_id, 'category', n.path, 'currency', s.currency,
            'totalCents', s.total, 'months', s.months) order by s.currency, s.total desc, n.path)
          from (select category_id, currency, sum(cents)::bigint as total,
              json_object_agg(month, cents order by month) as months
            from spending group by 1, 2) s
          left join names n on n.id = s.category_id) as spending,
        ${candidatesJson()} as candidates,
        (select json_agg(x.item order by x.occurred_at desc, x.transaction_id) from (
          select o.occurred_at, o.transaction_id, json_build_object(
              'transactionId', o.transaction_id, 'date', to_char(o.occurred_at, 'YYYY-MM-DD'),
              'description', t.description, 'accountName', a.name, 'category', n.path,
              'currency', o.currency, 'amountCents', o.amount_cents, 'usualCents', o.median_cents) as item
          from outliers o
          join tx t on t.id = o.transaction_id
          join accounts a on a.id = t.from_account_id
          left join names n on n.id = o.category_id
          order by o.occurred_at desc, o.transaction_id
          limit ${MAX_OUTLIERS}) x) as outliers,
        (select json_agg(json_build_object(
            'categoryId', g.category_id, 'category', n.path, 'currency', g.currency,
            'recentMonthlyCents', round(g.recent)::bigint, 'baselineMonthlyCents', round(g.base)::bigint,
            'changePercent', round((g.recent / g.base - 1) * 100)::int
          ) order by g.currency, g.recent - g.base desc)
          from growth g
          left join names n on n.id = g.category_id
          where g.base > 0 and g.recent * 100 > g.base * ${GROWTH_PERCENT}::int) as growing`);

    return {
      today: w.today,
      fromMonth: w.fromMonth,
      currentMonth: w.currentMonth,
      recentMonths: Array.from({ length: w.recentCount }, (_, i) => shiftMonth(w.recentFrom, i)),
      spending: row?.spending ?? [],
      recurring: subscriptionsOf(row?.candidates ?? null, w.today),
      outliers: row?.outliers ?? [],
      growing: row?.growing ?? [],
    };
  });
}

/**
 * «Suscripciones» (RF-185): the repeated charges `spending_patterns` finds over the last twelve
 * closed months plus the current one, by the same rules. One statement, one round trip.
 */
export async function listRecurringCharges(today: string = todayInBogota()): Promise<RecurringCharge[]> {
  const w = windowOf(12, today, 0);
  return withUserDb(async (tx) => {
    const [row] = await tx.execute<{ candidates: Candidate[] | null }>(sql`
      ${patternsSql(w)}
      select ${candidatesJson()} as candidates`);
    return subscriptionsOf(row?.candidates ?? null, w.today);
  });
}
