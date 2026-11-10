import { z } from "zod";

import { MAX_INSTALMENTS, MIN_INSTALMENTS } from "@/lib/deferral";
import { occurredAtSchema } from "@/lib/validation/transaction";

// RF-144: one line of a bank statement as Claude read it. The sign says which way the money went on
// the statement's own account: negative left it, positive entered it.
export const statementRowSchema = z.object({
  line: z.number().int().positive(),
  date: occurredAtSchema,
  description: z.string().trim().min(1).max(200),
  amountCents: z
    .number()
    .int()
    .refine((value) => value !== 0 && Math.abs(value) <= Number.MAX_SAFE_INTEGER),
  // The bank's own reference for the line, when it prints one (RF-134).
  reference: z.string().trim().min(1).max(200).optional(),
  // What the money was for, or the other account it came from or went to (a transfer).
  categoryId: z.uuid().optional(),
  counterAccountId: z.uuid().optional(),
  // A transfer to or from an account in another currency: what moved on that account, in its own
  // currency, as the person confirms it («¿cuánto te llegó?»). The two amounts are the rate (TRM).
  counterAmountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  // The other side is not known: the movement waits for a person to name it (RF-133).
  unsure: z.boolean().optional(),
  // The statement printed «1/36» on this purchase: it is proposed as deferred into 36 instalments, and
  // the person confirming the preview is the confirmation (RF-136).
  instalments: z.number().int().min(MIN_INSTALMENTS).max(MAX_INSTALMENTS).optional(),
});

// The statement the lines were read from. A statement is told apart by its account and its cut-off
// date, so a re-import names the same one and replaces its rows (RF-134): Claude reads both off the
// statement. Without a printed closing balance the one the movements derive is recorded.
const statementPeriodSchema = z.object({
  periodStart: occurredAtSchema,
  cutOffDate: occurredAtSchema,
  // As the statement printed it, signed like the account (a card's debt is negative).
  closingBalanceCents: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
});

export const statementSchema = z
  .object({
    accountId: z.uuid(),
    rows: z.array(statementRowSchema).min(1).max(500),
    statement: statementPeriodSchema,
  })
  .superRefine(({ accountId, rows, statement }, ctx) => {
    if (statement.periodStart > statement.cutOffDate) {
      ctx.addIssue({ code: "custom", path: ["statement", "periodStart"], message: "period after cut-off" });
    }
    const lines = new Set<number>();
    const refs = new Set<string>();
    rows.forEach((row, index) => {
      if (row.date < statement.periodStart || row.date > statement.cutOffDate) {
        ctx.addIssue({ code: "custom", path: ["rows", index, "date"], message: "outside the statement's period" });
      }
      if (lines.has(row.line)) ctx.addIssue({ code: "custom", path: ["rows", index, "line"], message: "repeated line" });
      lines.add(row.line);
      if (row.reference !== undefined) {
        if (refs.has(row.reference)) {
          ctx.addIssue({ code: "custom", path: ["rows", index, "reference"], message: "repeated reference" });
        }
        refs.add(row.reference);
      }
      if (row.counterAccountId === accountId) {
        ctx.addIssue({ code: "custom", path: ["rows", index, "counterAccountId"], message: "same account" });
      }
    });
  });

export const statementImportSchema = statementSchema.and(z.object({ previewKey: z.string().min(1) }));

export type StatementRow = z.infer<typeof statementRowSchema>;
export type StatementInput = z.infer<typeof statementSchema>;
