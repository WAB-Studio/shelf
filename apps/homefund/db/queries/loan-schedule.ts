import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { insertRow } from "@/db/insert-row";
import { loanScheduleRows } from "@/db/schema";
import { withUserDb, type Transaction } from "@/db/session";
import { todayInBogota } from "@/lib/dates";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import {
  digest,
  readSchedule,
  type LoanScheduleDigest,
  type LoanScheduleSummary,
  type SchedulePayment,
  type ScheduleRow,
} from "@/lib/loan-schedule";
import type { LoanScheduleInput } from "@/lib/validation/loan-schedule";

export type RawRow = Record<keyof ScheduleRow, string | number>;
export type RawPayment = { occurredOn: string; amountCents: string };

// The bank's rows of one loan, in order, as a jsonb array. `account` is the SQL text of the loan's id in the
// statement that embeds this, a literal of ours: it is written with the alias's own name, never a Drizzle column
// reference, which renders bare inside a projection and binds inward.
export function scheduleRowsSql(account: string): SQL<RawRow[]> {
  return sql<RawRow[]>`coalesce((
    select jsonb_agg(jsonb_build_object(
      'number', r.number, 'dueOn', r.due_on::text,
      'principalCents', r.principal_cents::text, 'interestCents', r.interest_cents::text,
      'insuranceCents', r.insurance_cents::text, 'totalCents', r.total_cents::text,
      'remainingCents', r.remaining_cents::text) order by r.number)
    from loan_schedule_rows r where r.account_id = ${sql.raw(account)}
  ), '[]'::jsonb)`;
}

// What reached the loan: each transfer into it in its own currency, the payments a schedule's rows are read against.
export function schedulePaymentsSql(account: string, currency: string): SQL<RawPayment[]> {
  return sql<RawPayment[]>`coalesce((
    select jsonb_agg(jsonb_build_object('occurredOn', t.occurred_at::text, 'amountCents', t.amount_cents::text))
    from transactions t
    where t.to_account_id = ${sql.raw(account)} and t.from_account_id is not null
      and t.currency = ${sql.raw(currency)}
  ), '[]'::jsonb)`;
}


/** The rows and payments a statement read as jsonb, turned into the figures `readSchedule` reads. */
export function scheduleOf(rows: RawRow[], payments: RawPayment[]): LoanScheduleSummary | null {
  return readSchedule(
    rows.map((row) => ({
      number: Number(row.number),
      dueOn: String(row.dueOn),
      principalCents: Number(row.principalCents),
      interestCents: Number(row.interestCents),
      insuranceCents: Number(row.insuranceCents),
      totalCents: Number(row.totalCents),
      remainingCents: Number(row.remainingCents),
    })),
    payments.map((payment): SchedulePayment => ({ occurredOn: payment.occurredOn, amountCents: Number(payment.amountCents) })),
    todayInBogota(),
  );
}

type LoanRead = { subtype: string; canWrite: boolean; kept: number; rows: RawRow[]; payments: RawPayment[] };

// One loan, the caller's right to write it, how many rows it holds and what reached it, in ONE statement; absent when
// the policies show no such liability.
async function readLoan(tx: Transaction, accountId: string): Promise<LoanRead | null> {
  const [row] = await tx.execute<LoanRead>(sql`
    select a.subtype, private.can_write_account(a.id) as "canWrite",
      (select count(*)::int from loan_schedule_rows r where r.account_id = a.id) as kept,
      ${scheduleRowsSql("a.id")} as rows,
      ${schedulePaymentsSql("a.id", "a.settlement_currency")} as payments
    from accounts a
    where a.id = ${accountId}::uuid and a.kind = 'liability'`);
  return row ?? null;
}

/** The loan's schedule read against its payments (RF-264), or null when it carries none or the caller cannot see it. */
export async function getLoanSchedule(accountId: string): Promise<LoanScheduleSummary | null> {
  const loan = await withUserDb((tx) => readLoan(tx, accountId));
  return loan === null ? null : scheduleOf(loan.rows, loan.payments);
}

export type LoanScheduleWrite = {
  // True when nothing was written: the answer says what the call would do.
  dryRun: boolean;
  // How many rows the loan held before, and how many the call sets.
  replaced: number;
  rows: number;
  // The proposed schedule read against what has already been paid.
  schedule: LoanScheduleDigest;
};

// The refusals the table's own guards raise, said once for every door.
function mapScheduleError(error: unknown): never {
  const code = pgErrorCode(error);
  // LS001: the account is not a loan.
  if (code === "LS001") throw new ActionError("loanSchedule.errors.notALoan");
  if (code === "42501") throw new ActionError("errors.notFound");
  if (code === "23503") throw new ActionError("errors.referenceGone");
  if (code === "23505" || code === "23514") throw new ActionError("loanSchedule.errors.invalid");
  throw error;
}

/**
 * Sets a loan's payment schedule (RF-264): the bank's rows replace any the loan holds, in ONE transaction, the old
 * ones deleted and the new ones written. With `dryRun` nothing is written and the answer is what the write would
 * leave, read against the payments the loan already has, so the person says yes to what they will see.
 */
export async function setLoanSchedule(input: LoanScheduleInput, dryRun: boolean): Promise<LoanScheduleWrite> {
  try {
    return await withUserDb(async (tx) => {
      const loan = await readLoan(tx, input.accountId);
      if (loan === null || !loan.canWrite) throw new ActionError("errors.notFound");
      if (loan.subtype !== "loan") throw new ActionError("loanSchedule.errors.notALoan");

      if (!dryRun) {
        await tx.execute(sql`delete from loan_schedule_rows where account_id = ${input.accountId}::uuid`);
        await insertRow(
          tx,
          loanScheduleRows,
          input.rows.map((row) => ({ accountId: input.accountId, ...row })),
        );
      }
      // The proposed rows, never the stored ones: a dry run has written none.
      const schedule = scheduleOf(
        input.rows.map((row) => ({ ...row })),
        loan.payments,
      );
      if (schedule === null) throw new ActionError("loanSchedule.errors.rowsRequired");
      return { dryRun, replaced: loan.kept, rows: input.rows.length, schedule: digest(schedule) };
    });
  } catch (error) {
    if (error instanceof ActionError) throw error;
    return mapScheduleError(error);
  }
}
