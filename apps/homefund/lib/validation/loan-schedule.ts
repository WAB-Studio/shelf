import { z } from "zod";

import { isCivilDate } from "@/lib/dates";
import { BASE_CURRENCY } from "@/lib/currency";
import { ActionError } from "@/lib/errors";
import { maxAmountMinor } from "@/lib/money";

// RF-264: the rows of a bank's payment schedule, as the bank printed them, in integer cents. A schedule is read
// whole or refused whole, and a refusal names the row it is about (`{row}`, counting from 1) so a misread
// figure is found in the paper at once.
export const MAX_SCHEDULE_ROWS = 600;

const cents = (error: string) =>
  z
    .number({ error })
    .int({ error })
    .min(0, { error })
    .max(maxAmountMinor(BASE_CURRENCY), { error });

const rowSchema = z.object({
  dueOn: z.string({ error: "loanSchedule.errors.dateInvalid" }).refine(isCivilDate, { error: "loanSchedule.errors.dateInvalid" }),
  principalCents: cents("loanSchedule.errors.amountInvalid"),
  interestCents: cents("loanSchedule.errors.amountInvalid"),
  insuranceCents: cents("loanSchedule.errors.amountInvalid").default(0),
  // What the bank printed as the cuota; absent, it is the sum of the three parts.
  totalCents: cents("loanSchedule.errors.amountInvalid").optional(),
  remainingCents: cents("loanSchedule.errors.amountInvalid"),
});

export const loanScheduleSchema = z
  .object({
    accountId: z.uuid({ error: "errors.notFound" }),
    rows: z
      .array(rowSchema, { error: "loanSchedule.errors.rowsRequired" })
      .min(1, { error: "loanSchedule.errors.rowsRequired" })
      .max(MAX_SCHEDULE_ROWS, { error: "loanSchedule.errors.rowsTooMany" }),
  })
  .transform((data, ctx) => {
    const rows = data.rows.map((row, index) => {
      const sum = row.principalCents + row.interestCents + row.insuranceCents;
      return { ...row, number: index + 1, totalCents: row.totalCents ?? sum, sum };
    });
    const refuse = (index: number, message: string) => ctx.addIssue({ code: "custom", message, path: ["rows", index] });
    rows.forEach((row, index) => {
      if (row.totalCents !== row.sum || row.totalCents === 0) return refuse(index, "loanSchedule.errors.totalMismatch");
      // The capital still owed falls by exactly what this row repays: a digit misread breaks the chain.
      const before = index === 0 ? null : rows[index - 1].remainingCents;
      if (before !== null && row.remainingCents + row.principalCents !== before) return refuse(index, "loanSchedule.errors.chainBroken");
      if (index > 0 && row.dueOn <= rows[index - 1].dueOn) return refuse(index, "loanSchedule.errors.datesNotIncreasing");
    });
    if (rows[rows.length - 1].remainingCents !== 0) refuse(rows.length - 1, "loanSchedule.errors.notPaidOff");
    if (ctx.issues.length > 0) return z.NEVER;
    return {
      accountId: data.accountId,
      rows: rows.map((row) => ({
        number: row.number,
        dueOn: row.dueOn,
        principalCents: row.principalCents,
        interestCents: row.interestCents,
        insuranceCents: row.insuranceCents,
        totalCents: row.totalCents,
        remainingCents: row.remainingCents,
      })),
    };
  });

export type LoanScheduleFields = z.input<typeof loanScheduleSchema>;
export type LoanScheduleInput = z.output<typeof loanScheduleSchema>;

/** Reads a schedule or throws the refusal of its first fault, naming the row as `{row}` when it is a row's. */
export function parseLoanSchedule(data: unknown): LoanScheduleInput {
  const verdict = loanScheduleSchema.safeParse(data);
  if (verdict.success) return verdict.data;
  const [issue] = verdict.error.issues;
  const index = issue.path.find((part): part is number => typeof part === "number");
  throw new ActionError(issue.message, index === undefined ? undefined : { row: String(index + 1) });
}
