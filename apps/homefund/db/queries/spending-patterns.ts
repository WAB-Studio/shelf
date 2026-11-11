import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { withUserDb } from "@/db/session";
import { monthRange, shiftMonth, todayInBogota } from "@/lib/dates";
import { ABOVE_USUAL_FACTOR, USUAL_MIN_LINES, USUAL_WINDOW_MONTHS } from "@/lib/month-review-rules";
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

// The fixed rules (RF-184). A series repeats when it holds this many charges on distinct days,
// its median gap falls in a cadence's band, and two thirds of its gaps and of its amounts hold
// steady (an amount within 20 % of the series' median).
const MIN_OCCURRENCES = 3;
// A series is still running while its next charge is at most this many days late.
const GRACE_DAYS = { monthly: 10, weekly: 3 } as const;
// A category grows when its average over the recent months is over this percent of the months before.
export const GROWTH_PERCENT = 125;
const RECENT_MONTHS = 3;
const MAX_OUTLIERS = 50;

type Window = {
  today: string;
  fromMonth: string;
  currentMonth: string;
  recentFrom: string;
  recentCount: number;
  baselineCount: number;
};

function windowOf(months: number, today: string): Window {
  const currentMonth = today.slice(0, 7);
  const fromMonth = shiftMonth(currentMonth, -months);
  const recentCount = Math.min(RECENT_MONTHS, Math.floor(months / 2));
  return {
    today,
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
  const historyStart = `${shiftMonth(w.fromMonth, -USUAL_WINDOW_MONTHS)}-01`;
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
      select t.*, nullif(btrim(regexp_replace(
          translate(lower(coalesce(t.description, '')), 'áàâäãéèêëíìîïóòôöõúùûüñç', 'aaaaaeeeeiiiiooooouuuunc'),
          '[^a-z]+', ' ', 'g')), '') as pattern_key
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
    gaps as (
      select c.*, c.occurred_at - lag(c.occurred_at)
        over (partition by c.pattern_key, c.account_id, c.currency order by c.occurred_at) as gap
      from charges c
    ),
    series as (
      select pattern_key, account_id, currency, count(*)::int as occurrences,
        percentile_disc(0.5) within group (order by gap) as median_gap,
        percentile_disc(0.5) within group (order by amount_cents) as typical_cents,
        min(occurred_at) as first_date, max(occurred_at) as last_date,
        (array_agg(description order by occurred_at desc))[1] as description,
        (array_agg(transaction_id order by occurred_at desc))[1] as transaction_id
      from gaps
      group by 1, 2, 3
      having count(*) >= ${MIN_OCCURRENCES}
    ),
    cadenced as (
      select s.*, b.cadence, b.lo, b.hi, b.grace,
        case b.cadence when 'monthly' then (s.last_date + interval '1 month')::date else s.last_date + 7 end as next_expected
      from series s
      join (values ('monthly', 25, 35, ${GRACE_DAYS.monthly}::int), ('weekly', 6, 8, ${GRACE_DAYS.weekly}::int))
        as b(cadence, lo, hi, grace) on s.median_gap between b.lo and b.hi
    ),
    recurring as (
      select c.*
      from cadenced c
      join gaps g using (pattern_key, account_id, currency)
      group by c.pattern_key, c.account_id, c.currency, c.occurrences, c.median_gap, c.typical_cents, c.first_date,
        c.last_date, c.description, c.transaction_id, c.cadence, c.lo, c.hi, c.grace, c.next_expected
      having 3 * count(*) filter (where 5 * g.amount_cents between 4 * c.typical_cents and 6 * c.typical_cents) >= 2 * c.occurrences
        and 3 * count(*) filter (where g.gap between c.lo and c.hi) >= 2 * (c.occurrences - 1)
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
        percentile_disc(0.5) within group (order by h.amount_cents) as median_cents
      from cells c
      join lines h using (category_id, currency)
      where h.month < c.month and h.month >= c.from_month
      group by 1, 2, 3
      having count(*) >= ${USUAL_MIN_LINES}::int
    ),
    outliers as (
      select distinct on (l.transaction_id) l.transaction_id, l.occurred_at, l.currency, l.category_id,
        l.amount_cents, u.median_cents
      from lines l
      join usual u using (category_id, currency, month)
      where l.amount_cents > ${ABOVE_USUAL_FACTOR}::int * u.median_cents
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

// The repeated charges as JSON; it reads `recurring` and `names` from `patternsSql`'s chain.
function recurringJson(w: Window): SQL {
  return sql`(select json_agg(json_build_object(
      'name', r.description, 'accountId', r.account_id, 'accountName', a.name,
      'scope', case when a.group_id is null then 'personal' else 'fund' end,
      'category', (select n.path from transaction_splits s join names n on n.id = s.category_id
        where s.transaction_id = r.transaction_id order by s.amount_cents desc, s.id limit 1),
      'currency', r.currency, 'cadence', r.cadence, 'typicalCents', r.typical_cents,
      'occurrences', r.occurrences, 'firstDate', to_char(r.first_date, 'YYYY-MM-DD'),
      'lastDate', to_char(r.last_date, 'YYYY-MM-DD'), 'nextExpected', to_char(r.next_expected, 'YYYY-MM-DD'),
      'active', r.next_expected + r.grace >= ${w.today}::date
    ) order by r.next_expected, r.description)
    from recurring r join accounts a on a.id = r.account_id)`;
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
      recurring: RecurringCharge[] | null;
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
        ${recurringJson(w)} as recurring,
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
      recurring: row?.recurring ?? [],
      outliers: row?.outliers ?? [],
      growing: row?.growing ?? [],
    };
  });
}
