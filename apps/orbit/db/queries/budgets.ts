import "server-only";

import { eq, sql } from "drizzle-orm";

import { insertRow } from "@/db/insert-row";
import { budgets } from "@/db/schema";
import type { Budget } from "@/db/schema";
import { withUserDb } from "@/db/session";
import { BASE_CURRENCY } from "@/lib/currency";
import { periodRange, todayInBogota } from "@/lib/dates";

type BudgetPeriod = Budget["period"];

export type BudgetStatus = {
  id: string;
  name: string | null;
  categoryId: string;
  accountId: string | null;
  labelId: string | null;
  period: BudgetPeriod;
  thresholdPct: number;
  // What the limit and the spend are counted in, derived and never stored
  // (RF-121, RF-124): the settlement currency of the account the budget names,
  // the fund's when it is the fund's, else its owner's own.
  currency: string;
  limitCents: number;
  spentCents: number;
  remainingCents: number;
  overThreshold: boolean;
  overspent: boolean;
};

/**
 * Every non-archived budget with its spent and remaining derived in ONE grouped
 * read — never one round trip per budget (RF-72, RNF-09). Spent sums the budget
 * category's expense splits over the budget's own period window, optionally
 * narrowed to the movements touching its account and/or carrying its label, and
 * only the movements booked in the budget's own currency, so no limit is ever
 * measured against two currencies added together (RF-124); a
 * correlated subselect picks each row's window by its period. The window bounds
 * come from `periodRange` around `anchorDate` (today by default), so a stored
 * spent column never exists; the anchor only slides the window the split sum
 * derives over, never a budget's period or threshold (RF-72).
 * `archived` swaps the listing onto the archived side (RF-120): the two sides
 * partition the readable budgets, and an archived one derives its figures the
 * same way, since nothing about the spend is special-cased or stored.
 * Scope is the policy's job: `withUserDb` shows only the caller's readable rows.
 */
export async function listBudgetsWithStatus(
  anchorDate?: string,
  options?: { archived?: boolean; today?: string },
): Promise<BudgetStatus[]> {
  // The clock is read once, so an anchor cannot be compared against one Bogotá
  // day and windowed against the next.
  const today = options?.today ?? todayInBogota();
  // No future period is served: an anchor past today collapses onto today. Both
  // sides are civil `YYYY-MM-DD`, so the ordering is the calendar's (RNF-06) and
  // no instant — hence no zone offset — enters the comparison.
  const anchor = anchorDate !== undefined && anchorDate < today ? anchorDate : today;

  const archivedFilter = options?.archived
    ? sql`b.archived_at is not null`
    : sql`b.archived_at is null`;

  const monthly = periodRange("monthly", anchor);
  const weekly = periodRange("weekly", anchor);
  const yearly = periodRange("yearly", anchor);

  return withUserDb(async (tx) => {
    const rows = await tx.execute<{
      id: string;
      name: string | null;
      category_id: string;
      account_id: string | null;
      label_id: string | null;
      period: BudgetPeriod;
      threshold_pct: number;
      currency: string;
      limit_cents: string;
      spent_cents: string;
    }>(sql`
      select
        b.id,
        b.name,
        b.category_id,
        b.account_id,
        b.label_id,
        b.period,
        b.threshold_pct,
        cur.code as currency,
        b.limit_cents,
        coalesce((
          select sum(s.amount_cents)
          from transaction_splits s
          join transactions t on t.id = s.transaction_id
          where s.category_id = b.category_id
            and t.kind = 'expense'
            and t.occurred_at >= (case b.period
              when 'weekly' then ${weekly.start}
              when 'yearly' then ${yearly.start}
              else ${monthly.start} end)::date
            and t.occurred_at < (case b.period
              when 'weekly' then ${weekly.endExclusive}
              when 'yearly' then ${yearly.endExclusive}
              else ${monthly.endExclusive} end)::date
            and (b.account_id is null
              or t.from_account_id = b.account_id or t.to_account_id = b.account_id)
            and (b.label_id is null or exists (
              select 1 from transaction_labels tl
              where tl.transaction_id = t.id and tl.label_id = b.label_id))
            and t.currency = cur.code
        ), 0) as spent_cents
      from budgets b
      left join accounts a on a.id = b.account_id
      left join groups g on g.id = b.group_id
      left join app_users u on u.id = b.owner_user_id
      -- The scope is an XOR, so at most one of the fund's and the owner's ever
      -- answers. The last leg is the one case none of them can: another member's
      -- personal budget naming no account, whose owner's row app_users_select_self
      -- keeps out of reach — it reads in the base currency rather than in none.
      cross join lateral (select coalesce(
        a.settlement_currency, g.currency, u.settlement_currency, ${BASE_CURRENCY}
      ) as code) cur
      where ${archivedFilter}
      order by b.name
    `);

    return rows.map((row) => {
      // A bigint sum arrives from the driver as a string; the ledger keeps cents a number.
      const limitCents = Number(row.limit_cents);
      const spentCents = Number(row.spent_cents);

      return {
        id: row.id,
        name: row.name,
        categoryId: row.category_id,
        accountId: row.account_id,
        labelId: row.label_id,
        period: row.period,
        thresholdPct: row.threshold_pct,
        currency: row.currency,
        limitCents,
        spentCents,
        remainingCents: limitCents - spentCents,
        // Cross-multiplied so the threshold check stays integer, never a float.
        overThreshold: spentCents * 100 >= limitCents * row.threshold_pct,
        overspent: spentCents > limitCents,
      };
    });
  });
}

/**
 * The currency a budget's limit is written and read in, in ONE round trip
 * (RF-121). The same chain the listing derives, asked of one budget: the
 * account it names, then the scope it belongs to — the fund's currency for a
 * group budget, its owner's own for a personal one — and the base currency
 * when the caller may read none of them. A write that names no budget yet
 * falls through to the caller's own fund and row, which is what a new budget
 * of theirs will derive.
 *
 * RLS does the scoping: `groups` shows the caller their one fund and
 * `app_users` shows them only their own row, so neither subselect needs a
 * predicate of its own.
 */
export async function resolveBudgetCurrency({
  budgetId = null,
  accountId = null,
}: {
  budgetId?: string | null;
  accountId?: string | null;
}): Promise<string> {
  return withUserDb(async (tx) => {
    const [row] = await tx.execute<{ code: string }>(sql`
      select coalesce(
        (select a.settlement_currency from accounts a where a.id = ${accountId}::uuid),
        (select coalesce(g.currency, u.settlement_currency)
           from budgets b
           left join groups g on g.id = b.group_id
           left join app_users u on u.id = b.owner_user_id
          where b.id = ${budgetId}::uuid),
        (select g.currency from groups g limit 1),
        (select u.settlement_currency from app_users u limit 1),
        ${BASE_CURRENCY}
      ) as code
    `);

    return row.code;
  });
}

// The scope is resolved by the caller (owner XOR group); the category, account
// and label narrowing must share it, which the `assert_budget_scope` trigger checks.
export type CreateBudgetArgs = {
  ownerUserId: string | null;
  groupId: string | null;
  categoryId: string;
  accountId: string | null;
  labelId: string | null;
  period: BudgetPeriod;
  limitCents: number;
  thresholdPct: number;
  name: string | null;
};

export async function createBudget({
  ownerUserId,
  groupId,
  categoryId,
  accountId,
  labelId,
  period,
  limitCents,
  thresholdPct,
  name,
}: CreateBudgetArgs): Promise<{ budgetId: string }> {
  return withUserDb(async (tx) => {
    const [row] = await insertRow(
      tx,
      budgets,
      {
        ownerUserId,
        groupId,
        categoryId,
        accountId,
        labelId,
        period,
        limitCents,
        thresholdPct,
        name,
      },
      { returning: { id: budgets.id } },
    );

    return { budgetId: row.id };
  });
}

// The scope and the category are immutable and absent from the UPDATE grant, so
// an edit only touches these fields; the boolean reports whether the policy admitted it.
export type UpdateBudgetArgs = {
  budgetId: string;
  accountId: string | null;
  labelId: string | null;
  period: BudgetPeriod;
  limitCents: number;
  thresholdPct: number;
  name: string | null;
};

export async function updateBudget({
  budgetId,
  accountId,
  labelId,
  period,
  limitCents,
  thresholdPct,
  name,
}: UpdateBudgetArgs): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(budgets)
      .set({ accountId, labelId, period, limitCents, thresholdPct, name })
      .where(eq(budgets.id, budgetId))
      .returning({ id: budgets.id });

    return rows.length > 0;
  });
}

// RF-120: archiving keeps the budget and its limit, so nothing already derived
// moves — the split sum reads movements, never a budget's flag.
export async function archiveBudget({
  budgetId,
}: {
  budgetId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(budgets)
      .set({ archivedAt: sql`now()` })
      .where(eq(budgets.id, budgetId))
      .returning({ id: budgets.id });

    return rows.length > 0;
  });
}

// The update policy scopes by owner-or-group and carries no archived predicate,
// so an archived budget stays inside the same USING that archived it (RF-120).
export async function restoreBudget({
  budgetId,
}: {
  budgetId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(budgets)
      .set({ archivedAt: null })
      .where(eq(budgets.id, budgetId))
      .returning({ id: budgets.id });

    return rows.length > 0;
  });
}

export async function deleteBudget({
  budgetId,
}: {
  budgetId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .delete(budgets)
      .where(eq(budgets.id, budgetId))
      .returning({ id: budgets.id });

    return rows.length > 0;
  });
}
