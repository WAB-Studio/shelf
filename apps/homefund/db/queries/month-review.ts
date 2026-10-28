import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { transactionReviews } from "@/db/schema";
import { withUserDb } from "@/db/session";
import { addCivilMonths, monthRange, todayInBogota } from "@/lib/dates";

import type { ReviewRule } from "@/lib/month-review-rules";

export type { ReviewRule };

export type ReviewItem = {
  rule: ReviewRule;
  transactionIds: string[];
  occurredAt: string;
  amountCents: number;
  currency: string;
  accountName: string;
  categoryName: string | null;
  usualCents: number | null;
  countedCents: number | null;
  reviewed: boolean;
  canMark: boolean;
};

export type MonthReview = { month: string; firstMonth: string | null; items: ReviewItem[] };

// The month's items by RF-155's four fixed rules (O7-Q2 a for «above usual»), as one CTE chain
// the item read and the pending count share. RLS scopes every table it touches.
function reviewItemsSql(month: string): SQL {
  const { start, endExclusive } = monthRange(`${month}-01`);
  const historyStart = addCivilMonths(start, -6);
  return sql`
    with expense_splits as (
      select t.id as transaction_id, t.occurred_at, t.currency, t.from_account_id as account_id,
        s.category_id, s.amount_cents
      from transaction_splits s
      join transactions t on t.id = s.transaction_id
      where t.from_account_id is not null and t.to_account_id is null
        and t.reconciliation_id is null and s.category_id is not null
        and t.occurred_at >= ${historyStart}::date and t.occurred_at < ${endExclusive}::date
    ),
    -- One item per movement: its largest split over three times its category's median, with
    -- at least three splits of history in the six months before the month, in its currency.
    above_usual as (
      select distinct on (e.transaction_id)
        e.transaction_id, e.occurred_at, e.currency, e.account_id, e.category_id, e.amount_cents,
        h.median_cents
      from expense_splits e
      cross join lateral (
        select percentile_disc(0.5) within group (order by p.amount_cents) as median_cents,
          count(*) as splits
        from expense_splits p
        where p.category_id = e.category_id and p.currency = e.currency
          and p.occurred_at >= ${historyStart}::date and p.occurred_at < ${start}::date
      ) h
      where e.occurred_at >= ${start}::date and e.occurred_at < ${endExclusive}::date
        and h.splits >= 3 and e.amount_cents > 3 * h.median_cents
      order by e.transaction_id, e.amount_cents desc
    ),
    twins as (
      select array_agg(t.id order by t.id) as ids, t.occurred_at, t.amount_cents, t.currency,
        coalesce(t.from_account_id, t.to_account_id) as account_id
      from transactions t
      where t.occurred_at >= ${start}::date and t.occurred_at < ${endExclusive}::date
        and t.reconciliation_id is null
      group by t.occurred_at, t.from_account_id, t.to_account_id, t.amount_cents, t.currency
      having count(*) >= 2
    ),
    items as (
      select 'above_usual'::text as rule, array[a.transaction_id] as ids, a.occurred_at,
        a.amount_cents, a.currency, a.account_id, a.category_id,
        a.median_cents::bigint as usual_cents, null::bigint as counted_cents
      from above_usual a
      union all
      select 'twin', w.ids, w.occurred_at, w.amount_cents, w.currency, w.account_id,
        (select s.category_id from transaction_splits s where s.transaction_id = w.ids[1] limit 1),
        null, null
      from twins w
      union all
      select 'from_words', array[t.id], t.occurred_at, t.amount_cents, t.currency,
        coalesce(t.from_account_id, t.to_account_id),
        (select s.category_id from transaction_splits s where s.transaction_id = t.id limit 1),
        null, null
      from transactions t
      where t.amount_from_words
        and t.occurred_at >= ${start}::date and t.occurred_at < ${endExclusive}::date
      union all
      select 'reconciliation_gap', array[t.id], t.occurred_at, t.amount_cents, t.currency,
        coalesce(t.from_account_id, t.to_account_id), null, null, r.counted_balance_cents
      from transactions t
      join account_reconciliations r on r.id = t.reconciliation_id
      where t.occurred_at >= ${start}::date and t.occurred_at < ${endExclusive}::date
    ),
    marked as (
      select i.*,
        (select bool_and(exists (
          select 1 from ${transactionReviews} m where m.transaction_id = u.tid and m.rule = i.rule
        )) from unnest(i.ids) as u(tid)) as reviewed,
        (select bool_and(coalesce(private.can_write_transaction_row(u.tid), false))
          from unnest(i.ids) as u(tid)) as can_mark
      from items i
    )`;
}

/**
 * A month's «Revisar el mes» (RF-155): every item the four rules raise, with whether it is
 * already marked «Está bien» and whether the caller may mark it, plus the earliest month the
 * caller has a movement in. One statement, one round trip.
 */
export async function getMonthReview(month: string): Promise<MonthReview> {
  return withUserDb(async (tx) => {
    const [row] = await tx.execute<{ first_month: string | null; items: RawItem[] | null }>(sql`
      ${reviewItemsSql(month)}
      select
        (select to_char(min(t.occurred_at), 'YYYY-MM') from transactions t) as first_month,
        (select json_agg(json_build_object(
          'rule', m.rule, 'ids', m.ids, 'occurred_at', m.occurred_at, 'amount_cents', m.amount_cents,
          'currency', m.currency, 'account_name', a.name, 'category_name', c.name,
          'usual_cents', m.usual_cents, 'counted_cents', m.counted_cents,
          'reviewed', m.reviewed, 'can_mark', m.can_mark
        ) order by m.occurred_at, m.rule, m.ids[1])
        from marked m
        join accounts a on a.id = m.account_id
        left join categories c on c.id = m.category_id) as items`);

    return {
      month,
      firstMonth: row?.first_month ?? null,
      items: (row?.items ?? []).map(toItem),
    };
  });
}

/**
 * Inicio's line (RF-155, O7-Q1 a): last month's unmarked items the caller can mark, or null when
 * none stand out. The screen's rows and account join, so the count never names a row it hides.
 */
export async function getMonthReviewPending(): Promise<{ month: string; count: number } | null> {
  const month = addCivilMonths(`${todayInBogota().slice(0, 7)}-01`, -1).slice(0, 7);
  const count = await withUserDb(async (tx) => {
    const [row] = await tx.execute<{ count: number }>(sql`
      ${reviewItemsSql(month)}
      select count(*)::int as count
      from marked m
      join accounts a on a.id = m.account_id
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

type RawItem = {
  rule: ReviewRule;
  ids: string[];
  occurred_at: string;
  amount_cents: number;
  currency: string;
  account_name: string;
  category_name: string | null;
  usual_cents: number | null;
  counted_cents: number | null;
  reviewed: boolean;
  can_mark: boolean;
};

function toItem(raw: RawItem): ReviewItem {
  return {
    rule: raw.rule,
    transactionIds: raw.ids,
    occurredAt: raw.occurred_at,
    amountCents: Number(raw.amount_cents),
    currency: raw.currency,
    accountName: raw.account_name,
    categoryName: raw.category_name,
    usualCents: raw.usual_cents === null ? null : Number(raw.usual_cents),
    countedCents: raw.counted_cents === null ? null : Number(raw.counted_cents),
    reviewed: raw.reviewed,
    canMark: raw.can_mark,
  };
}
