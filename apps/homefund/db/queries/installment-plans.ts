import "server-only";

import { eq, inArray, sql } from "drizzle-orm";

import { insertRow } from "@/db/insert-row";
import { installmentLines, installmentPlans, transactions } from "@/db/schema";
import type { Account, InstallmentPlan } from "@/db/schema";
import { withUserDb } from "@/db/session";

// The caller computes the dated schedule (RF-81); this only writes the plan and
// its lines. The interest rate is a fraction, so it travels as a decimal string
// and casts to numeric in SQL; every cent field stays an integer.
export type CreateInstallmentPlanArgs = {
  accountId: string;
  description: string | null;
  principalCents: number;
  nInstallments: number;
  frequency: InstallmentPlan["frequency"];
  interestRate: string | null;
  downPaymentCents: number | null;
  avalCents: number | null;
  startDate: string;
  merchant: string | null;
  lines: { seq: number; dueDate: string; amountCents: number }[];
};

/**
 * The plan and its lines in ONE `withUserDb` (RF-81): insert the plan and read
 * its id, then one multi-row insert of the dated lines. A plan schedules an
 * existing balance and moves no money — no transaction is written here.
 */
export async function createInstallmentPlan({
  accountId,
  description,
  principalCents,
  nInstallments,
  frequency,
  interestRate,
  downPaymentCents,
  avalCents,
  startDate,
  merchant,
  lines,
}: CreateInstallmentPlanArgs): Promise<{ planId: string }> {
  return withUserDb(async (tx) => {
    // A decimal string binds straight to the numeric rate — the column casts it.
    const [plan] = await insertRow(
      tx,
      installmentPlans,
      {
        accountId,
        description,
        principalCents,
        nInstallments,
        frequency,
        interestRate,
        downPaymentCents,
        avalCents,
        startDate,
        merchant,
      },
      { returning: { id: installmentPlans.id } },
    );

    const planId = plan.id;

    if (lines.length > 0) {
      await insertRow(
        tx,
        installmentLines,
        lines.map((line) => ({
          planId,
          seq: line.seq,
          dueDate: line.dueDate,
          amountCents: line.amountCents,
        })),
      );
    }

    return { planId };
  });
}

export type InstallmentPlanLine = {
  id: string;
  seq: number;
  dueDate: string;
  amountCents: number;
  paidTransactionId: string | null;
};

export type InstallmentPlanRow = {
  id: string;
  accountId: string;
  description: string | null;
  principalCents: number;
  nInstallments: number;
  frequency: InstallmentPlan["frequency"];
  interestRate: string | null;
  downPaymentCents: number | null;
  avalCents: number | null;
  startDate: string;
  merchant: string | null;
  pendingCents: number;
  paidCents: number;
  lines: InstallmentPlanLine[];
};

/**
 * Every plan on the account with its lines and derived pending and paid figures
 * in ONE round trip (RF-81, RNF-09): the lines ride along as a correlated
 * `jsonb_agg` and the two totals as filtered sums, never an N+1 follow-up.
 * Pending is the sum of the unpaid lines and is never a stored column.
 */
export async function listPlansForAccount(
  accountId: string,
): Promise<InstallmentPlanRow[]> {
  return withUserDb(async (tx) => {
    const rows = await tx.execute<{
      id: string;
      account_id: string;
      description: string | null;
      principal_cents: number;
      n_installments: number;
      frequency: InstallmentPlan["frequency"];
      interest_rate: string | null;
      down_payment_cents: number | null;
      aval_cents: number | null;
      start_date: string;
      merchant: string | null;
      pending_cents: string;
      paid_cents: string;
      lines: InstallmentPlanLine[];
    }>(sql`
      select
        p.id,
        p.account_id,
        p.description,
        p.principal_cents,
        p.n_installments,
        p.frequency,
        p.interest_rate,
        p.down_payment_cents,
        p.aval_cents,
        p.start_date,
        p.merchant,
        coalesce((
          select sum(l.amount_cents) from installment_lines l
          where l.plan_id = p.id and l.paid_transaction_id is null
        ), 0) as pending_cents,
        coalesce((
          select sum(l.amount_cents) from installment_lines l
          where l.plan_id = p.id and l.paid_transaction_id is not null
        ), 0) as paid_cents,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', l.id, 'seq', l.seq, 'dueDate', l.due_date,
            'amountCents', l.amount_cents, 'paidTransactionId', l.paid_transaction_id
          ) order by l.due_date, l.seq)
          from installment_lines l where l.plan_id = p.id
        ), '[]'::jsonb) as lines
      from installment_plans p
      where p.account_id = ${accountId}
      order by p.start_date desc, p.created_at desc
    `);

    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      description: row.description,
      principalCents: Number(row.principal_cents),
      nInstallments: Number(row.n_installments),
      frequency: row.frequency,
      interestRate: row.interest_rate,
      downPaymentCents: row.down_payment_cents === null ? null : Number(row.down_payment_cents),
      avalCents: row.aval_cents === null ? null : Number(row.aval_cents),
      startDate: row.start_date,
      merchant: row.merchant,
      // A bigint sum arrives from the driver as a string; the ledger keeps cents a number.
      pendingCents: Number(row.pending_cents),
      paidCents: Number(row.paid_cents),
      lines: row.lines,
    }));
  });
}

export type PlanPosition = {
  accountId: string;
  linesTotal: number;
  linesPaid: number;
  pendingCents: number;
  nextDueDate: string | null;
  nextAmountCents: number | null;
};

/**
 * One row per account that carries a plan, with the position its lines add up to,
 * in ONE round trip (RF-81, RF-82, RNF-09): how many lines the account's plans
 * hold, how many a movement already paid, what the unpaid ones still owe, and the
 * earliest unpaid line's date and amount. Pending is a filtered sum over the
 * unpaid lines, never a stored column (RNF-07).
 *
 * `installment_plans`'s own policy is the whole scope: a plan on an account the
 * caller cannot read returns no row, so no count states a debt they may not see.
 * `debt_terms` is not joined — a plan sits on any liability, and one without terms
 * still has a position to state.
 */
export async function listPlanPositions(): Promise<PlanPosition[]> {
  return withUserDb(async (tx) => {
    const rows = await tx.execute<{
      account_id: string;
      lines_total: string;
      lines_paid: string;
      pending_cents: string;
      next_due_date: string | null;
      next_amount_cents: string | null;
    }>(sql`
      select
        p.account_id,
        count(l.id) as lines_total,
        count(l.paid_transaction_id) as lines_paid,
        coalesce(
          sum(l.amount_cents) filter (where l.paid_transaction_id is null), 0
        ) as pending_cents,
        min(l.due_date) filter (where l.paid_transaction_id is null) as next_due_date,
        -- The amount of the row next_due_date names, read in the same order the
        -- FIFO walk uses, so the two never disagree on which line comes next.
        (array_agg(l.amount_cents order by l.due_date, l.seq)
          filter (where l.paid_transaction_id is null))[1] as next_amount_cents
      from installment_plans p
      -- LEFT: an account whose plan has no lines yet still reports its position.
      left join installment_lines l on l.plan_id = p.id
      group by p.account_id
    `);

    // A bigint sum or count arrives from the driver as a string; the ledger keeps
    // cents a number.
    return rows.map((row) => ({
      accountId: row.account_id,
      linesTotal: Number(row.lines_total),
      linesPaid: Number(row.lines_paid),
      pendingCents: Number(row.pending_cents),
      nextDueDate: row.next_due_date,
      nextAmountCents:
        row.next_amount_cents === null ? null : Number(row.next_amount_cents),
    }));
  });
}

/**
 * The refusal a payment gets when the accounts it names are the wrong kinds. It
 * carries the sqlstate a check constraint would have carried, because that is
 * what the action layer reads off the cause chain — the guard is only decided a
 * statement earlier, before anything is written.
 */
class DebtPaymentRefusal extends Error {
  readonly code = "23514";
}

/**
 * A payment against a liability and its auto-FIFO allocation in ONE `withUserDb`
 * (RF-16, RF-82): (1) the kinds guard and the debt's unpaid lines, read in the
 * same statement so the refusal costs no round trip and lands BEFORE anything is
 * written; (2) the oldest-first walk over those lines, ordered by due date then
 * seq, linking each line the running remainder covers IN FULL and stopping at the
 * first it cannot; (3) the transfer that credits the liability, in the ledger's
 * own transfer shape — both accounts, no split, no label (scope, kind and
 * created_by fall to triggers). What the walk did not spend is returned
 * unallocated; unlinking happens on its own when the paying movement is deleted.
 */
export async function recordDebtPayment({
  fromAccountId,
  toAccountId,
  amountCents,
  occurredAt,
}: {
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  occurredAt: string;
}): Promise<{
  transactionId: string;
  paidLineIds: string[];
  remainderCents: number;
}> {
  return withUserDb(async (tx) => {
    // The two kinds ride the read of the unpaid lines: one statement, and the
    // single-row `k` keeps them coming back even when the debt has no lines.
    const rows = await tx.execute<{
      from_kind: Account["kind"] | null;
      to_kind: Account["kind"] | null;
      line_id: string | null;
      amount_cents: string | null;
    }>(sql`
      select k.from_kind, k.to_kind, l.id as line_id, l.amount_cents
      from (
        select
          (select a.kind from accounts a where a.id = ${fromAccountId}) as from_kind,
          (select a.kind from accounts a where a.id = ${toAccountId}) as to_kind
      ) k
      left join lateral (
        select l.id, l.amount_cents, l.due_date, l.seq
        from installment_lines l
        join installment_plans p on p.id = l.plan_id
        where p.account_id = ${toAccountId} and l.paid_transaction_id is null
      ) l on true
      order by l.due_date, l.seq
    `);

    const [head] = rows;
    // A kind that came back null is an account the policies did not show: the
    // insert below answers that with 42501, the refusal the caller already reads.
    if (head.from_kind !== null && head.from_kind !== "asset") {
      throw new DebtPaymentRefusal("a debt payment comes from an asset account");
    }
    if (head.to_kind !== null && head.to_kind !== "liability") {
      throw new DebtPaymentRefusal("a debt payment credits a liability account");
    }

    const paidLineIds: string[] = [];
    let remainder = amountCents;
    for (const row of rows) {
      if (row.line_id === null) break;
      const owed = Number(row.amount_cents);
      // Fully-covered lines only: the first line the remainder falls short of ends the walk.
      if (remainder < owed) break;
      remainder -= owed;
      paidLineIds.push(row.line_id);
    }

    // `created_by`, the scope and `kind` are set by triggers/generation and
    // absent from the INSERT grant.
    const [txn] = await insertRow(
      tx,
      transactions,
      { fromAccountId, toAccountId, amountCents, occurredAt },
      { returning: { id: transactions.id } },
    );

    const transactionId = txn.id;

    if (paidLineIds.length > 0) {
      await tx
        .update(installmentLines)
        .set({ paidTransactionId: transactionId })
        .where(inArray(installmentLines.id, paidLineIds));
    }

    // What is left after the last fully-covered line, and it stays unallocated.
    return { transactionId, paidLineIds, remainderCents: remainder };
  });
}

// The cascade removes the plan's lines; the boolean reports whether the policy
// admitted the delete. A line's paying movement is never touched.
export async function deleteInstallmentPlan({
  planId,
}: {
  planId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .delete(installmentPlans)
      .where(eq(installmentPlans.id, planId))
      .returning({ id: installmentPlans.id });

    return rows.length > 0;
  });
}
