import { sql, type SQL } from "drizzle-orm";

import { patternKeySql } from "@/db/queries/learned-category";
import {
  ABOVE_USUAL_FACTOR,
  ABOVE_USUAL_MEDIAN_FACTOR,
  ABOVE_USUAL_P90_PERCENT,
  USUAL_MIXED_FACTOR,
  USUAL_MIN_CENTS,
  USUAL_MIN_LINES,
  USUAL_MIN_SAME_CATEGORY,
  USUAL_MIN_SAME_DESCRIPTION,
} from "@/lib/month-review-rules";

// «Above usual», written once for every query that asks it. `spending_patterns` (RF-184) groups the lines of
// its own window with the first three helpers; «Revisar el mes» (RF-239) has its own, below.

// A category's usual in a currency: the median of its lines' amounts.
export function usualMedianSql(amount: SQL): SQL {
  return sql`percentile_disc(0.5) within group (order by ${amount})`;
}

// A `having` clause: a usual rests on at least this many lines.
export const hasUsualHistorySql: SQL = sql`count(*) >= ${USUAL_MIN_LINES}::int`;

// A line is above usual when it passes the factor times the usual.
export function isAboveUsualSql(amount: SQL, median: SQL): SQL {
  return sql`${amount} > ${ABOVE_USUAL_FACTOR}::int * ${median}`;
}

// «Revisar el mes» (RF-239) compares whole movements, not split lines: a grocery trip recorded as twenty small
// lines is one purchase. It writes the CTEs `above_usual` reads (one row per flagged movement: its category,
// its amount, and the quartiles and count of what it was compared with). The earlier six months supply the
// history; the month's own movements are never part of it.
export function aboveUsualMovementsSql(range: { start: string; endExclusive: string; historyStart: string }): SQL {
  const floors = Object.entries(USUAL_MIN_CENTS).map(([currency, cents]) => sql`when ${currency} then ${cents}::bigint`);
  const quartiles = sql`count(*)::int as n,
        percentile_disc(0.25) within group (order by amount_cents) as low,
        percentile_disc(0.5) within group (order by amount_cents) as mid,
        percentile_disc(0.75) within group (order by amount_cents) as high,
        percentile_disc(0.9) within group (order by amount_cents) as p90,
        percentile_disc(0.95) within group (order by amount_cents) as p95`;
  return sql`
    -- Each expense with the key of its description and the category of its largest split.
    expense_tx as materialized (
      select t.id, t.occurred_at, t.currency, t.amount_cents, t.from_account_id, t.recurring_rule_id,
        ${patternKeySql(sql`t.description`)} as pattern_key, c.category_id
      from transactions t
      left join lateral (
        select s.category_id from transaction_splits s
        where s.transaction_id = t.id order by s.amount_cents desc, s.id limit 1
      ) c on true
      where t.kind = 'expense' and t.reconciliation_id is null
        and t.occurred_at >= ${range.historyStart}::date and t.occurred_at < ${range.endExclusive}::date
    ),
    usual_description as (
      select pattern_key, currency, ${quartiles}
      from expense_tx
      where occurred_at < ${range.start}::date and pattern_key is not null
      group by pattern_key, currency
      having count(*) >= ${USUAL_MIN_SAME_DESCRIPTION}::int
    ),
    usual_category as (
      select category_id, currency, ${quartiles}
      from expense_tx
      where occurred_at < ${range.start}::date and category_id is not null
      group by category_id, currency
      having count(*) >= ${USUAL_MIN_SAME_CATEGORY}::int
    ),
    -- The description's own history wins when it has enough; the category's is the fallback.
    compared as (
      select m.id as transaction_id, m.category_id, m.amount_cents, m.currency, m.from_account_id,
        m.recurring_rule_id,
        case when d.n is not null then 'description' else 'category' end as basis,
        coalesce(d.n, c.n) as n, coalesce(d.low, c.low) as low, coalesce(d.mid, c.mid) as mid,
        coalesce(d.high, c.high) as high, coalesce(d.p90, c.p90) as p90, coalesce(d.p95, c.p95) as p95
      from expense_tx m
      left join usual_description d on d.pattern_key = m.pattern_key and d.currency = m.currency
      left join usual_category c on c.category_id = m.category_id and c.currency = m.currency
      where m.occurred_at >= ${range.start}::date and (d.n is not null or c.n is not null)
    ),
    -- A mixed category is no basis; nothing stands out that a rule or a planned payment already expects (its own,
    -- or one for this amount on this account).
    above_usual as (
      select x.transaction_id, x.category_id, x.amount_cents, x.basis, x.n, x.low, x.mid, x.high
      from compared x
      where x.amount_cents * 100 > x.p90 * ${ABOVE_USUAL_P90_PERCENT}::int
        and x.amount_cents >= ${ABOVE_USUAL_MEDIAN_FACTOR}::int * x.mid
        and x.amount_cents >= case x.currency ${sql.join(floors, sql` `)} else ${USUAL_MIN_CENTS.COP}::bigint end
        and (x.basis = 'description' or x.p95 <= ${USUAL_MIXED_FACTOR}::int * x.mid)
        and x.recurring_rule_id is null
        and not exists (select 1 from recurring_rules r
          where r.from_account_id = x.from_account_id and r.amount_cents = x.amount_cents)
        and not exists (select 1 from planned_payments p
          where p.status <> 'cancelled'
            and (p.settled_transaction_id = x.transaction_id
              or (p.from_account_id = x.from_account_id and p.amount_cents = x.amount_cents)))
    )`;
}
