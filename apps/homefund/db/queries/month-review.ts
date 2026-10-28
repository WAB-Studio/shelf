import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { transactionReviews } from "@/db/schema";
import { withUserDb } from "@/db/session";
import { addCivilMonths, lastClosedMonth, monthRange } from "@/lib/dates";

import type { ReviewRule } from "@/lib/month-review-rules";

export type ReviewItem = {
  rule: ReviewRule;
  transactionIds: string[];
  occurredAt: string;
  amountCents: number;
  currency: string;
  accountName: string;
  categoryName: string | null;
  description: string | null;
  usualCents: number | null;
  countedCents: number | null;
  reviewed: boolean;
  canMark: boolean;
};

// `noted`: the month holds a movement the caller can read, so an empty review is a checked one.
export type MonthReview = { month: string; firstMonth: string | null; noted: boolean; items: ReviewItem[] };

// The month's items by RF-155's four fixed rules (O7-Q2 a for «above usual»), as one CTE chain
// the item read and the pending count share. RLS scopes every table it touches.
function reviewItemsSql(month: string): SQL {
  const { start, endExclusive } = monthRange(`${month}-01`);
  const historyStart = addCivilMonths(start, -6);
  return sql`
    with month_tx as materialized (
      select t.id, t.occurred_at, t.amount_cents, t.currency, t.from_account_id, t.to_account_id,
        coalesce(t.from_account_id, t.to_account_id) as account_id, t.reconciliation_id, t.amount_from_words,
        t.description
      from transactions t
      where t.occurred_at >= ${start}::date and t.occurred_at < ${endExclusive}::date
    ),
    expense_splits as (
      select t.id as transaction_id, t.occurred_at, t.currency, s.category_id, s.amount_cents
      from transaction_splits s
      join transactions t on t.id = s.transaction_id
      where t.kind = 'expense' and t.reconciliation_id is null and s.category_id is not null
        and t.occurred_at >= ${historyStart}::date and t.occurred_at < ${endExclusive}::date
    ),
    -- A category's usual in a currency: the median of its splits in the six months before the
    -- month, once it has at least three.
    usual as (
      select category_id, currency,
        percentile_disc(0.5) within group (order by amount_cents) as median_cents
      from expense_splits
      where occurred_at < ${start}::date
      group by category_id, currency
      having count(*) >= 3
    ),
    -- One item per movement: its largest split over three times its category's usual.
    above_usual as (
      select distinct on (e.transaction_id) e.transaction_id, e.category_id, e.amount_cents, u.median_cents
      from expense_splits e
      join usual u using (category_id, currency)
      where e.occurred_at >= ${start}::date and e.amount_cents > 3 * u.median_cents
      order by e.transaction_id, e.amount_cents desc
    ),
    flagged as (
      select 'above_usual'::text as rule, array[a.transaction_id] as ids, a.amount_cents,
        a.category_id, a.median_cents::bigint as usual_cents, null::bigint as counted_cents,
        true as one_description
      from above_usual a
      union all
      select 'twin', array_agg(t.id order by t.id), t.amount_cents, null, null, null,
        count(distinct coalesce(t.description, '')) = 1
      from month_tx t
      where t.reconciliation_id is null
      group by t.occurred_at, t.from_account_id, t.to_account_id, t.amount_cents, t.currency
      having count(*) >= 2
      union all
      select 'from_words', array[t.id], t.amount_cents, null, null, null, true
      from month_tx t where t.amount_from_words
      union all
      select 'reconciliation_gap', array[t.id], t.amount_cents, null, null, r.counted_balance_cents, true
      from month_tx t join account_reconciliations r on r.id = t.reconciliation_id
    ),
    -- A twin's ids share their day and accounts, so its first movement speaks for all of them; its
    -- description too, unless the twin's movements read differently.
    marked as (
      select f.rule, f.ids, f.amount_cents, f.usual_cents, f.counted_cents, t.occurred_at, t.currency,
        t.account_id,
        case when f.one_description then t.description end as description,
        case when f.rule = 'reconciliation_gap' then null else coalesce(f.category_id,
          (select s.category_id from transaction_splits s where s.transaction_id = t.id limit 1)) end
          as category_id,
        (select count(*) from ${transactionReviews} m
          where m.rule = f.rule and m.transaction_id = any(f.ids)) = cardinality(f.ids) as reviewed,
        coalesce(private.can_write_transaction(t.from_account_id, t.to_account_id), false) as can_mark
      from flagged f
      join month_tx t on t.id = f.ids[1]
    )`;
}

/**
 * A month's «Revisar el mes» (RF-155): every item the four rules raise, with whether it is
 * already marked «Está bien» and whether the caller may mark it, plus the earliest month the
 * caller has a movement in. One statement, one round trip.
 */
export async function getMonthReview(month: string): Promise<MonthReview> {
  return withUserDb(async (tx) => {
    const [row] = await tx.execute<{ first_month: string | null; noted: boolean; items: ReviewItem[] | null }>(sql`
      ${reviewItemsSql(month)}
      select
        (select to_char(min(t.occurred_at), 'YYYY-MM') from transactions t) as first_month,
        exists (select 1 from month_tx) as noted,
        (select json_agg(json_build_object(
          'rule', m.rule, 'transactionIds', m.ids, 'occurredAt', m.occurred_at,
          'amountCents', m.amount_cents, 'currency', m.currency, 'accountName', a.name,
          'categoryName', c.name, 'description', m.description, 'usualCents', m.usual_cents, 'countedCents', m.counted_cents,
          'reviewed', m.reviewed, 'canMark', m.can_mark
        ) order by m.occurred_at, m.rule, m.ids[1])
        from marked m
        join accounts a on a.id = m.account_id
        left join categories c on c.id = m.category_id) as items`);

    return {
      month,
      firstMonth: row?.first_month ?? null,
      noted: row?.noted ?? false,
      items: row?.items ?? [],
    };
  });
}

/**
 * Inicio's line (RF-155, O7-Q1 a): the movements in last month's unmarked items the caller can
 * mark, each once though a twin holds two and one movement may stand under two rules; null when
 * none stand out. The screen's rows and account join, so the count never names a row it hides.
 */
export async function getMonthReviewPending(): Promise<{ month: string; count: number } | null> {
  const month = lastClosedMonth();
  const count = await withUserDb(async (tx) => {
    const [row] = await tx.execute<{ count: number }>(sql`
      ${reviewItemsSql(month)}
      select count(distinct movement_id)::int as count
      from marked m
      join accounts a on a.id = m.account_id
      cross join unnest(m.ids) as movement_id
      where not m.reviewed and m.can_mark`);
    return row?.count ?? 0;
  });
  return count > 0 ? { month, count } : null;
}

/** Marks each movement «Está bien» for one rule; a mark already there is kept. */
export async function markReviewed(input: {
  transactionIds: string[];
  rule: ReviewRule;
}): Promise<void> {
  // Only the two granted columns travel: `marked_by` is the trigger's, from `auth.uid()`.
  await withUserDb(async (tx) => {
    const rows = input.transactionIds.map((id) => sql`(${id}::uuid, ${input.rule})`);
    await tx.execute(sql`
      insert into ${transactionReviews} (transaction_id, rule)
      values ${sql.join(rows, sql`, `)}
      on conflict do nothing`);
  });
}

/** «Deshacer» under «Revisados» (RF-163): drops the item's marks, so it waits again. */
export async function unmarkReviewed(input: {
  transactionIds: string[];
  rule: ReviewRule;
}): Promise<boolean> {
  // False when the policy filtered a movement's mark out: the caller may not write it.
  return withUserDb(async (tx) => {
    const gone = await tx.execute(sql`
      delete from ${transactionReviews}
      where rule = ${input.rule}
        and transaction_id in (${sql.join(input.transactionIds.map((id) => sql`${id}::uuid`), sql`, `)})
      returning transaction_id`);
    return gone.length === input.transactionIds.length;
  });
}
