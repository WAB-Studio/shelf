import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { aboveUsualMovementsSql } from "@/db/queries/above-usual";
import { transactionReviews } from "@/db/schema";
import { withUserDb } from "@/db/session";
import { addCivilMonths, lastClosedMonth, monthRange } from "@/lib/dates";

import { USUAL_WINDOW_MONTHS, type ReviewRule, type UsualBasis } from "@/lib/month-review-rules";

// One of a twin's equal movements, so the person sees what to compare.
export type ReviewEntry = { id: string; description: string | null; createdBy: string; createdAt: string };

export type ReviewItem = {
  rule: ReviewRule;
  transactionIds: string[];
  occurredAt: string;
  amountCents: number;
  currency: string;
  accountName: string;
  categoryName: string | null;
  description: string | null;
  // What «above usual» was compared with (RF-239): the middle and the typical range (the middle half) of
  // the earlier movements of its description or category, and how many they were. Null on the other rules.
  usualCents: number | null;
  usualLowCents: number | null;
  usualHighCents: number | null;
  usualBasis: UsualBasis | null;
  usualCount: number | null;
  usualWindowMonths: number;
  entries: ReviewEntry[];
  countedCents: number | null;
  reviewed: boolean;
  canMark: boolean;
};

// `noted`: the month holds a movement the caller can read, so an empty review is a checked one.
export type MonthReview = { month: string; firstMonth: string | null; noted: boolean; items: ReviewItem[] };

// The month's items by RF-155's four fixed rules , as one CTE chain
// the item read and the pending count share. RLS scopes every table it touches.
function reviewItemsSql(month: string): SQL {
  const { start, endExclusive } = monthRange(`${month}-01`);
  const historyStart = addCivilMonths(start, -USUAL_WINDOW_MONTHS);
  return sql`
    with month_tx as materialized (
      select t.id, t.occurred_at, t.amount_cents, t.currency, t.from_account_id, t.to_account_id,
        coalesce(t.from_account_id, t.to_account_id) as account_id, t.reconciliation_id, t.amount_from_words,
        t.description, t.created_by, t.created_at
      from transactions t
      where t.occurred_at >= ${start}::date and t.occurred_at < ${endExclusive}::date
    ),
    ${aboveUsualMovementsSql({ start, endExclusive, historyStart })},
    flagged as (
      select 'above_usual'::text as rule, array[a.transaction_id] as ids, a.amount_cents,
        a.category_id, a.mid::bigint as usual_cents, null::bigint as counted_cents,
        true as one_description, a.low::bigint as usual_low, a.high::bigint as usual_high,
        a.basis as usual_basis, a.n as usual_count
      from above_usual a
      union all
      select 'twin', array_agg(t.id order by t.id), t.amount_cents, null, null, null,
        count(distinct coalesce(t.description, '')) = 1, null, null, null, null
      from month_tx t
      where t.reconciliation_id is null
      group by t.occurred_at, t.from_account_id, t.to_account_id, t.amount_cents, t.currency
      having count(*) >= 2
      union all
      select 'from_words', array[t.id], t.amount_cents, null, null, null, true, null, null, null, null
      from month_tx t where t.amount_from_words
      union all
      select 'reconciliation_gap', array[t.id], t.amount_cents, null, null, r.counted_balance_cents, true,
        null, null, null, null
      from month_tx t join account_reconciliations r on r.id = t.reconciliation_id
    ),
    -- A twin's ids share their day and accounts, so its first movement speaks for all of them; its
    -- description too, unless the twin's movements read differently.
    marked as (
      select f.rule, f.ids, f.amount_cents, f.usual_cents, f.usual_low, f.usual_high, f.usual_basis, f.usual_count,
        f.counted_cents, t.occurred_at, t.currency,
        t.account_id,
        case when f.one_description then t.description end as description,
        case when f.rule = 'reconciliation_gap' then null else coalesce(f.category_id,
          (select s.category_id from transaction_splits s where s.transaction_id = t.id limit 1)) end
          as category_id,
        case when f.rule = 'twin' then (select json_agg(json_build_object(
          'id', e.id, 'description', e.description, 'createdBy', e.created_by, 'createdAt', e.created_at
        ) order by e.created_at, e.id) from month_tx e where e.id = any(f.ids)) end as entries,
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
          'categoryName', c.name, 'description', m.description, 'usualCents', m.usual_cents, 'usualLowCents', m.usual_low,
          'usualHighCents', m.usual_high, 'usualBasis', m.usual_basis, 'usualCount', m.usual_count,
          'usualWindowMonths', ${USUAL_WINDOW_MONTHS}::int,
          'entries', coalesce(m.entries, '[]'::json), 'countedCents', m.counted_cents,
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
 * Inicio's line (RF-155): the movements in last month's unmarked items the caller can
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
