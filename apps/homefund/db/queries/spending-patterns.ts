import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { withUserDb } from "@/db/session";
import { shiftMonth, todayInBogota } from "@/lib/dates";
import { USUAL_WINDOW_MONTHS } from "@/lib/month-review-rules";

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
// A category grows when its recent monthly average is over 125 % of the months before.
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
  const endExclusive = `${shiftMonth(w.currentMonth, 1)}-01`;
  const historyStart = `${shiftMonth(w.fromMonth, -USUAL_WINDOW_MONTHS)}-01`;
  return sql`
    with tx as materialized (
      select t.id, t.occurred_at, t.amount_cents, t.currency, t.from_account_id, t.description,
        -- The description without case, accents, digits or punctuation: «NETFLIX.COM 4412» and
        -- «Netflix.com 9921» are one series.
        nullif(btrim(regexp_replace(translate(lower(coalesce(t.description, '')), 'áéíóúüñ', 'aeiouun'),
          '[^a-z]+', ' ', 'g')), '') as pattern_key
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
      select c.id, case when p.id is null then c.name else p.name || ' › ' || c.name end as path
      from categories c left join categories p on p.id = c.parent_id
    ),
    spending as (
      select category_id, currency, month, sum(amount_cents)::bigint as cents
      from lines where occurred_at >= ${start}::date
      group by 1, 2, 3
    ),
    charges as (
      select pattern_key, from_account_id as account_id, currency, occurred_at,
        sum(amount_cents)::bigint as amount_cents, (array_agg(id order by id))[1] as transaction_id,
        (array_agg(description order by id))[1] as description
      from tx
      where pattern_key is not null and occurred_at >= ${start}::date
      group by 1, 2, 3, 4
    ),
    gaps as (
      select c.*, c.occurred_at - lag(c.occurred_at) over w as gap,
        row_number() over (partition by c.pattern_key, c.account_id, c.currency order by c.occurred_at desc) as recency
      from charges c
      window w as (partition by c.pattern_key, c.account_id, c.currency order by c.occurred_at)
    ),
    series as (
      select pattern_key, account_id, currency, count(*)::int as occurrences,
        percentile_disc(0.5) within group (order by gap) as median_gap,
        percentile_disc(0.5) within group (order by amount_cents) as typical_cents,
        min(occurred_at) as first_date, max(occurred_at) as last_date
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
      select c.*, latest.description, latest.transaction_id
      from cadenced c
      join gaps latest on (latest.pattern_key, latest.account_id, latest.currency) = (c.pattern_key, c.account_id, c.currency)
        and latest.recency = 1
      where (
        select 3 * count(*) filter (where 5 * g.amount_cents between 4 * c.typical_cents and 6 * c.typical_cents) >= 2 * c.occurrences
          and 3 * count(*) filter (where g.gap between c.lo and c.hi) >= 2 * (c.occurrences - 1)
        from gaps g
        where (g.pattern_key, g.account_id, g.currency) = (c.pattern_key, c.account_id, c.currency)
      )
    ),
    -- RF-155's «above usual»: a line over three times its category's median in the six months
    -- before its month, once that median rests on three lines.
    cells as (
      select distinct category_id, currency, month from lines where occurred_at >= ${start}::date
    ),
    usual as (
      select c.category_id, c.currency, c.month, u.median_cents
      from cells c
      cross join lateral (
        select percentile_disc(0.5) within group (order by h.amount_cents) as median_cents, count(*) as n
        from lines h
        where h.category_id = c.category_id and h.currency = c.currency
          and h.month < c.month and h.month >= to_char(to_date(c.month, 'YYYY-MM') - make_interval(months => ${USUAL_WINDOW_MONTHS}::int), 'YYYY-MM')
      ) u
      where u.n >= 3
    ),
    outliers as (
      select distinct on (l.transaction_id) l.transaction_id, l.occurred_at, l.currency, l.category_id,
        l.amount_cents, u.median_cents
      from lines l
      join usual u using (category_id, currency, month)
      where l.amount_cents > 3 * u.median_cents
      order by l.transaction_id, l.amount_cents desc
    ),
    growth as (
      select category_id, currency,
        coalesce(sum(cents) filter (where month >= ${w.recentFrom}), 0) as recent,
        coalesce(sum(cents) filter (where month < ${w.recentFrom}), 0) as base
      from spending
      where month < ${w.currentMonth}
      group by 1, 2
    )`;
}

function recurringJson(today: string): SQL {
  return sql`(select json_agg(json_build_object(
      'name', r.description, 'accountId', r.account_id, 'accountName', a.name,
      'scope', case when a.group_id is null then 'personal' else 'fund' end,
      'category', (select n.path from transaction_splits s join names n on n.id = s.category_id
        where s.transaction_id = r.transaction_id order by s.amount_cents desc, s.id limit 1),
      'currency', r.currency, 'cadence', r.cadence, 'typicalCents', r.typical_cents,
      'occurrences', r.occurrences, 'firstDate', to_char(r.first_date, 'YYYY-MM-DD'),
      'lastDate', to_char(r.last_date, 'YYYY-MM-DD'), 'nextExpected', to_char(r.next_expected, 'YYYY-MM-DD'),
      'active', r.next_expected + r.grace >= ${today}::date
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
    }>(spendingPatternsSql(w));

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

function spendingPatternsSql(w: Window): SQL {
  return sql`
      ${patternsSql(w)}
      select
        (select json_agg(json_build_object(
            'categoryId', s.category_id, 'category', n.path, 'currency', s.currency,
            'totalCents', s.total, 'months', s.months) order by s.currency, s.total desc, n.path)
          from (select category_id, currency, sum(cents)::bigint as total,
              json_object_agg(month, cents order by month) as months
            from spending group by 1, 2) s
          left join names n on n.id = s.category_id) as spending,
        ${recurringJson(w.today)} as recurring,
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
            'recentMonthlyCents', round(g.recent::numeric / nullif(${w.recentCount}::int, 0))::bigint,
            'baselineMonthlyCents', round(g.base::numeric / ${w.baselineCount}::int)::bigint,
            'changePercent', round((g.recent * ${w.baselineCount}::int - g.base * ${w.recentCount}::int) * 100::numeric
              / (g.base * ${w.recentCount}::int))::int
          ) order by g.currency, g.recent * ${w.baselineCount}::int - g.base * ${w.recentCount}::int desc)
          from growth g
          left join names n on n.id = g.category_id
          where ${w.recentCount}::int > 0 and g.base > 0
            and g.recent * ${w.baselineCount}::int * 4 > g.base * ${w.recentCount}::int * 5) as growing`;
}
