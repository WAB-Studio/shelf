import { z } from "zod";

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
  // The other side is not known: the movement waits for a person to name it (RF-133).
  unsure: z.boolean().optional(),
});

export const statementSchema = z
  .object({ accountId: z.uuid(), rows: z.array(statementRowSchema).min(1).max(500) })
  .superRefine(({ accountId, rows }, ctx) => {
    const lines = new Set<number>();
    const refs = new Set<string>();
    rows.forEach((row, index) => {
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
