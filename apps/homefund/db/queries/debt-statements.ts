import "server-only";

import { sql } from "drizzle-orm";

import { minimumPaymentSql } from "@/db/queries/debt-minimum";
import { withUserDb } from "@/db/session";
import { nextDayOfMonthOnOrAfter, todayInBogota } from "@/lib/dates";

export type CurrentStatement = {
  accountId: string;
  periodStart: string;
  balanceCents: number;
  minimumPaymentCents: number;
  nextCutOffDate: string | null;
  nextDueDate: string | null;
};

/**
 * The open period's live figures, computed on the fly and never persisted: the
 * period opens the day after the last closed cut-off (the opening date before
 * any statement), the balance is the current derived one from `account_balances`,
 * and the minimum is derived on it (RF-79). The next cut-off and due dates come
 * from the latest statement's own printed dates when one exists; the stored
 * terms days answer only until a statement exists (RF-131). Null when the
 * account carries no terms.
 */
export async function getCurrentStatement(
  accountId: string,
): Promise<CurrentStatement | null> {
  const today = todayInBogota();

  return withUserDb(async (tx) => {
    const [row] = await tx.execute<{
      period_start: string;
      balance_cents: string;
      minimum_payment_cents: string;
      statement_cut_off_day: number | null;
      payment_due_day: number | null;
      latest_cut_off_date: string | null;
      latest_payment_due_date: string | null;
    }>(sql`
      select
        coalesce(ls.cut_off_date + 1, a.initial_balance_on) as period_start,
        b.balance_cents,
        ${minimumPaymentSql({
          fixed: sql`dt.minimum_payment_cents`,
          pct: sql`dt.minimum_payment_pct`,
          balance: sql`b.balance_cents`,
          fallback: sql`0`,
        })} as minimum_payment_cents,
        dt.statement_cut_off_day,
        dt.payment_due_day,
        ls.cut_off_date as latest_cut_off_date,
        ls.payment_due_date as latest_payment_due_date
      from debt_terms dt
      join accounts a on a.id = dt.account_id
      -- One balance row per account AND currency: the open period is cut in the
      -- currency the card bills in, and no figure here ever sums two (RF-124).
      join account_balances b
        on b.id = dt.account_id and b.currency = a.settlement_currency
      -- The latest closed statement, if any: the same row answers the period's
      -- opening date and, below, the cut-off and due dates the bank printed.
      left join lateral (
        select s.cut_off_date, s.payment_due_date
        from account_statements s
        where s.account_id = dt.account_id
        order by s.cut_off_date desc
        limit 1
      ) ls on true
      where dt.account_id = ${accountId}
    `);

    if (!row) return null;

    return {
      accountId,
      periodStart: row.period_start,
      // A bigint arrives from the driver as a string; the ledger keeps cents a number.
      balanceCents: Number(row.balance_cents),
      minimumPaymentCents: Number(row.minimum_payment_cents),
      nextCutOffDate:
        row.latest_cut_off_date !== null
          ? row.latest_cut_off_date
          : row.statement_cut_off_day === null
            ? null
            : nextDayOfMonthOnOrAfter(row.statement_cut_off_day, today),
      nextDueDate:
        row.latest_payment_due_date !== null
          ? row.latest_payment_due_date
          : row.payment_due_day === null
            ? null
            : nextDayOfMonthOnOrAfter(row.payment_due_day, today),
    };
  });
}

export type PendingSettlement = {
  id: string;
  occurredAt: string;
  description: string | null;
  // The currency the purchase happened in, never the account's (RF-121).
  currency: string;
  amountCents: number;
  // What the movement expects to be billed, still marked an estimate (RF-123).
  counterAmountCents: number;
};

/**
 * The card's purchases in another currency the issuer has not billed yet (RF-123):
 * a movement whose `currency` is not the account's settlement currency and whose
 * second amount is still an estimate. ONE round trip.
 *
 * Each row is bounded to the statement period it falls in — the cut-off on or
 * after the purchase, none while the period is still open — and the list leads
 * with the periods already cut, which are the ones a statement can answer for.
 * Nothing is grouped in SQL: the section reads as one list.
 */
export async function listPendingSettlements(
  accountId: string,
): Promise<PendingSettlement[]> {
  return withUserDb(async (tx) => {
    const rows = await tx.execute<{
      id: string;
      occurred_at: string;
      description: string | null;
      currency: string;
      amount_cents: string;
      counter_amount_cents: string;
    }>(sql`
      select
        t.id,
        t.occurred_at,
        t.description,
        t.currency,
        t.amount_cents,
        t.counter_amount_cents
      from accounts a
      join transactions t
        on t.from_account_id = a.id or t.to_account_id = a.id
      left join lateral (
        select min(s.cut_off_date) as cut_off_date
        from account_statements s
        where s.account_id = a.id and s.cut_off_date >= t.occurred_at
      ) p on true
      where a.id = ${accountId}
        and a.kind = 'liability'
        and t.currency <> a.settlement_currency
        and t.counter_is_estimate
      order by p.cut_off_date asc nulls last, t.occurred_at desc, t.id
    `);

    return rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      description: row.description,
      currency: row.currency,
      // A bigint arrives from the driver as a string; the ledger keeps cents a number.
      amountCents: Number(row.amount_cents),
      counterAmountCents: Number(row.counter_amount_cents),
    }));
  });
}

// Thrown inside the transaction so nothing commits; the action reads `reason`.
export class BilledAmountRefused extends Error {
  readonly reason = "beforeReconciliation";
}

export type RecordBilledAmountArgs = {
  transactionId: string;
  accountId: string;
  // The currency the caller read the amount in; the guard below refuses any other.
  currency: string;
  billedCents: number;
};

/**
 * Replaces the estimate on one foreign-currency purchase with what the issuer
 * billed (RF-123), in ONE round trip and in place: there is no history of
 * estimates. Clearing the mark is the whole mechanic — `account_balances` reads
 * the flag, so the amount leaves the currency pocket for the settlement one
 * without a single balance being written (RNF-07).
 *
 * The guard rides the same statement: the movement must touch this account (a
 * liability or an asset: a foreign purchase on a debit account is estimated too), the
 * account must settle in the currency the amount was read in, and the row must
 * still carry an estimate. False when no row answered — refused by
 * `transactions_update_writable`, already billed, or gone. An estimate dated on
 * or before the account's latest reconciliation is refused by
 * throwing `BilledAmountRefused` and writes nothing: the reconciliation counted it
 * already (RF-137); the same statement carries that check.
 */
export async function recordBilledAmount({
  transactionId,
  accountId,
  currency,
  billedCents,
}: RecordBilledAmountArgs): Promise<boolean> {
  return withUserDb(async (tx) => {
    // `blocked` and the update share the guard's own conditions, so a movement
    // that is not this card's estimate answers `replaced = 0` and not a refusal.
    const [row] = await tx.execute<{ replaced: string; blocked: boolean }>(sql`
      with blocked as (
        select exists (
          select 1
          from transactions t
          join accounts a on a.id = ${accountId}
          join account_reconciliations r on r.account_id = a.id
          where t.id = ${transactionId}
            and (t.from_account_id = a.id or t.to_account_id = a.id)
            and a.settlement_currency = ${currency}
            and t.currency <> a.settlement_currency
            and t.counter_is_estimate
            and r.reconciled_on >= t.occurred_at
        ) as is_blocked
      ),
      updated as (
        update transactions t
        set counter_amount_cents = ${billedCents}, counter_is_estimate = false
        from accounts a
        where t.id = ${transactionId}
          and a.id = ${accountId}
          and (t.from_account_id = a.id or t.to_account_id = a.id)
          and a.settlement_currency = ${currency}
          and t.currency <> a.settlement_currency
          and t.counter_is_estimate
          and not (select is_blocked from blocked)
        returning t.id
      )
      select (select count(*) from updated)::text as replaced,
             (select is_blocked from blocked) as blocked
    `);

    if (row?.blocked) throw new BilledAmountRefused("beforeReconciliation");
    return Number(row?.replaced ?? 0) > 0;
  });
}
