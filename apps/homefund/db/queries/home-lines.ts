import "server-only";

import { sql } from "drizzle-orm";

import { listReconcileAges } from "@/db/queries/account-reconciliations";
import { listAccounts } from "@/db/queries/accounts";
import { countInboxPending } from "@/db/queries/ingest-review";
import { minimumPaidSql, paidSince, periodStartSql } from "@/db/queries/debt-minimum";
import { listPlannedPayments } from "@/db/queries/planned-payments";
import { scheduleOf, scheduleRowsSql, schedulePaymentsSql, type RawPayment, type RawRow } from "@/db/queries/loan-schedule";
import { withUserDb } from "@/db/session";
import { currentMonthRange, nextDayOfMonthOnOrAfter, todayInBogota } from "@/lib/dates";
import { fixItems, type FixItem, type ShortLoan } from "@/lib/fund/home-lines";
import { isExpectedIncome } from "@/lib/fund/glance";
import type { UpcomingCardDebt, UpcomingLoanDebt } from "@/lib/fund/upcoming";
import { isStale } from "@/lib/reconcile-age";

// One card this month: what its statement asks, or null while no statement of this month is registered.
export type ToPayCard = {
  accountId: string;
  currency: string;
  totalCents: number | null;
  minimumCents: number | null;
  dueDate: string;
};

export type ToPayPayment = {
  id: string;
  description: string | null;
  currency: string;
  amountCents: number;
  dueDate: string;
};

export type HomeAhead = {
  cards: ToPayCard[];
  payments: ToPayPayment[];
  nextIncome: ToPayPayment | null;
  nextBill: ToPayPayment | null;
};

type CardRow = {
  account_id: string;
  name: string;
  currency: string;
  owed_cents: string;
  due_date: string | null;
  closing_cents: string | null;
  minimum_cents: string | null;
  payment_due_day: number | null;
  // What was paid this period covers its minimum (RF-281): the card asks nothing more this month.
  minimum_paid: boolean;
};

// Every card that still owes, with its latest statement and whether this period's minimum is paid, in one statement.
// Another member's personal card is theirs to pay (RF-58).
function readCardRows(today: string) {
  return withUserDb((tx) =>
    tx.execute<CardRow>(sql`
        select a.id as account_id, a.name, a.settlement_currency as currency, (-b.balance_cents)::text as owed_cents,
          ls.payment_due_date::text as due_date, ls.closing_balance_cents::text as closing_cents,
          ls.minimum_payment_cents::text as minimum_cents, dt.payment_due_day,
          ${minimumPaidSql({
            fixed: sql`dt.minimum_payment_cents`,
            pct: sql`dt.minimum_payment_pct`,
            balance: sql`b.balance_cents`,
            statementMinimum: sql`ls.minimum_payment_cents`,
            paid: sql`pp.paid`,
          })} as minimum_paid
        from accounts a
        join debt_terms dt on dt.account_id = a.id
        join account_balances b on b.id = a.id and b.currency = a.settlement_currency
        left join lateral (
          select s.cut_off_date, s.payment_due_date, s.closing_balance_cents, s.minimum_payment_cents
          from account_statements s where s.account_id = a.id order by s.cut_off_date desc limit 1
        ) ls on true
        cross join lateral (select ${periodStartSql({
          statementCutOff: sql`ls.cut_off_date`,
          cutOffDay: sql`dt.statement_cut_off_day`,
          today,
        })} as since) ps
        cross join lateral (select ${paidSince({ account: sql`a.id`, currency: sql`a.settlement_currency`, since: sql`ps.since` })} as paid) pp
        where a.kind = 'liability' and a.subtype = 'card' and a.archived_at is null and b.balance_cents < 0
          -- Another member's personal card is theirs to pay (RF-58).
          and (a.owner_user_id is null or a.owner_user_id = (select auth.uid()))
        order by a.name`),
  );
}

/**
 * What Inicio says about the month's payments and what comes next, in two parallel reads: each card that still owes
 * with its latest statement's total and due date, and the pending planned payments (RF-74). A statement counts only
 * while its due date falls in this month or later; an older one is not this month's, so the card asks for its extract.
 * A card whose minimum is already paid is left out (RF-281).
 */
export async function getHomeAhead(): Promise<HomeAhead> {
  const today = todayInBogota();
  const { start, endExclusive } = currentMonthRange();

  const [cardRows, pending] = await Promise.all([
    readCardRows(today),
    listPlannedPayments({ status: "pending" }),
  ]);

  const cards = cardRows.flatMap((row): ToPayCard[] => {
    // A card whose minimum is paid asks nothing more this month: the line leaves it out.
    if (row.minimum_paid) return [];
    const counts = row.due_date !== null && row.due_date >= start;
    const dueDate = counts
      ? row.due_date
      : row.payment_due_day === null
        ? null
        : nextDayOfMonthOnOrAfter(row.payment_due_day, today);
    if (dueDate === null || dueDate >= endExclusive) return [];

    if (!counts) {
      return [{ accountId: row.account_id, currency: row.currency, totalCents: null, minimumCents: null, dueDate }];
    }
    // A statement is never asked for more than the card owes today.
    const total = Math.min(-Number(row.closing_cents), Number(row.owed_cents));
    if (total <= 0) return [];
    const minimum = row.minimum_cents === null ? null : Number(row.minimum_cents);
    return [
      {
        accountId: row.account_id,
        currency: row.currency,
        totalCents: total,
        minimumCents: minimum !== null && minimum > 0 && minimum < total ? minimum : null,
        dueDate,
      },
    ];
  });

  const mine = pending.filter((payment) => !payment.foreignOwner);
  const view = (payment: (typeof mine)[number]): ToPayPayment => ({
    id: payment.id,
    description: payment.description,
    currency: payment.currency,
    amountCents: payment.amountCents,
    dueDate: payment.dueDate,
  });
  // A payment into another account is a transfer, the card's own among them: the card line already counts it.
  const outgoing = mine.filter((payment) => payment.fromAccountId !== null && payment.toAccountId === null);
  const coming = (payments: typeof mine) => payments.find((payment) => payment.dueDate >= today);

  const nextIncome = coming(mine.filter(isExpectedIncome));
  const nextBill = coming(outgoing);

  return {
    cards,
    payments: outgoing.filter((payment) => payment.dueDate < endExclusive).map(view),
    nextIncome: nextIncome ? view(nextIncome) : null,
    nextBill: nextBill ? view(nextBill) : null,
  };
}

export type UpcomingDebts = {
  cards: (UpcomingCardDebt & { dueDate: string })[];
  loans: (UpcomingLoanDebt & { dueDate: string })[];
};

/**
 * Each debt's next payment for «Lo que viene» (RF-308), in two parallel reads. A card that still owes, whose period's
 * minimum is not paid, asks its latest statement's total and minimum on the statement's due day; a statement older than
 * this month is not this month's, so the card says its extract is missing and takes its own payment day. A loan that
 * still owes asks the first cuota its schedule has not paid in full, less what already landed on it; with no schedule,
 * the cuota and day its terms name. A debt with no day to name is left out.
 */
export async function getUpcomingDebts(): Promise<UpcomingDebts> {
  const today = todayInBogota();
  const { start } = currentMonthRange();

  const [cardRows, loanRows] = await Promise.all([
    readCardRows(today),
    withUserDb((tx) =>
      tx.execute<{
        id: string;
        name: string;
        currency: string;
        minimum_cents: string | null;
        payment_due_day: number | null;
        rows: RawRow[];
        payments: RawPayment[];
      }>(sql`
        select a.id, a.name, a.settlement_currency as currency, dt.minimum_payment_cents::text as minimum_cents,
          dt.payment_due_day, ${scheduleRowsSql("a.id")} as rows,
          ${schedulePaymentsSql("a.id", "a.settlement_currency")} as payments
        from accounts a
        join account_balances b on b.id = a.id and b.currency = a.settlement_currency
        left join debt_terms dt on dt.account_id = a.id
        where a.kind = 'liability' and a.subtype = 'loan' and a.archived_at is null and b.balance_cents < 0
          and (a.owner_user_id is null or a.owner_user_id = (select auth.uid()))
        order by a.name`),
    ),
  ]);

  const cards = cardRows.flatMap((row): UpcomingDebts["cards"] => {
    if (row.minimum_paid) return [];
    const counts = row.due_date !== null && row.due_date >= start;
    const dueDate = counts
      ? row.due_date
      : row.payment_due_day === null
        ? null
        : nextDayOfMonthOnOrAfter(row.payment_due_day, today);
    if (dueDate === null) return [];

    const base = { accountId: row.account_id, name: row.name, currency: row.currency, dueDate };
    if (!counts) return [{ ...base, totalCents: null, minimumCents: null }];
    const total = Math.min(-Number(row.closing_cents), Number(row.owed_cents));
    if (total <= 0) return [];
    const minimum = row.minimum_cents === null ? null : Number(row.minimum_cents);
    return [{ ...base, totalCents: total, minimumCents: minimum !== null && minimum > 0 && minimum < total ? minimum : null }];
  });

  const loans = loanRows.flatMap((row): UpcomingDebts["loans"] => {
    const base = { accountId: row.id, name: row.name, currency: row.currency };
    const schedule = scheduleOf(row.rows, row.payments);
    if (schedule !== null) {
      const { next } = schedule;
      if (next === null) return [];
      return [
        { ...base, dueDate: next.dueOn, amountCents: next.totalCents - next.paidCents, number: next.number, count: schedule.count },
      ];
    }
    if (row.minimum_cents === null || row.payment_due_day === null) return [];
    return [
      {
        ...base,
        dueDate: nextDayOfMonthOnOrAfter(row.payment_due_day, today),
        amountCents: Number(row.minimum_cents),
        number: null,
        count: null,
      },
    ];
  });

  return { cards, loans };
}

/**
 * The loans whose cuotas were paid short: a day behind us and something paid, but not the cuota (RF-264). One statement
 * for every loan that carries a schedule, read against its payments.
 */
export async function listShortInstalments(): Promise<ShortLoan[]> {
  const today = todayInBogota();
  const loans = await withUserDb((tx) =>
    tx.execute<{ id: string; name: string; currency: string; rows: RawRow[]; payments: RawPayment[] }>(sql`
      select a.id, a.name, a.settlement_currency as currency,
        ${scheduleRowsSql("a.id")} as rows,
        ${schedulePaymentsSql("a.id", "a.settlement_currency")} as payments
      from accounts a
      where a.kind = 'liability' and a.subtype = 'loan' and a.archived_at is null
        and (a.owner_user_id is null or a.owner_user_id = (select auth.uid()))
        and exists (select 1 from loan_schedule_rows r where r.account_id = a.id)
      order by a.name`),
  );

  return loans.flatMap((loan) => {
    const short = (scheduleOf(loan.rows, loan.payments)?.rows ?? []).filter(
      (row) => row.overdue && row.paidCents > 0 && row.dueOn < today,
    );
    if (short.length === 0) return [];
    return [
      {
        accountId: loan.id,
        name: loan.name,
        currency: loan.currency,
        count: short.length,
        shortCents: short.reduce((sum, row) => sum + (row.totalCents - row.paidCents), 0),
      },
    ];
  });
}

export type MonthAdjustment = { accountName: string; currency: string; cents: number };

/**
 * The month's «Ajuste por cuadre» account by account, signed: + into the account, − out of it (RF-138). An account
 * whose adjustments cancel is left out. One read, the rows the month's total is the sum of.
 */
export async function listMonthAdjustments(range: { start: string; endExclusive: string }): Promise<MonthAdjustment[]> {
  const rows = await withUserDb((tx) =>
    tx.execute<{ name: string; currency: string; cents: string }>(sql`
      select a.name, t.currency,
        sum(case when t.to_account_id is not null then t.amount_cents else -t.amount_cents end)::text as cents
      from transactions t
      join accounts a on a.id = coalesce(t.to_account_id, t.from_account_id)
      where t.reconciliation_id is not null
        and t.occurred_at >= ${range.start} and t.occurred_at < ${range.endExclusive}
      group by a.id, a.name, t.currency
      having sum(case when t.to_account_id is not null then t.amount_cents else -t.amount_cents end) <> 0
      order by a.name, t.currency`),
  );
  return rows.map((row) => ({ accountName: row.name, currency: row.currency, cents: Number(row.cents) }));
}

/**
 * «Por arreglar» read whole, for the screen that has no read of these accounts yet («Revisar el mes»): the accounts,
 * Bandeja's count, the counts' ages and the cuotas paid short, fanned out at once.
 */
export async function getFixItems(): Promise<FixItem[]> {
  const today = todayInBogota();
  const [accounts, inboxCount, ages, shortLoans] = await Promise.all([
    listAccounts({ archived: false }),
    countInboxPending(),
    listReconcileAges(),
    listShortInstalments(),
  ]);

  return fixItems({
    // Another member's personal account is theirs to fix (RF-58).
    accounts: accounts.filter((account) => !account.foreignOwner),
    inboxCount,
    shortLoans,
    staleCount: ages.filter((row) => isStale(row, today)).length,
  });
}
