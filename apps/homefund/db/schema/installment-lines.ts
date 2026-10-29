import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  pgPolicy,
  smallint,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { installmentPlans } from "./installment-plans";
import { transactions } from "./transactions";

// The dated lines a plan generates (RF-81): each a due date and an amount (aval folded in). A payment
// is allocated oldest-first (RF-82); a line is marked paid only when covered in full, and the paying
// movement is linked. Pending derives from the unpaid lines and is never stored. No scope of its own —
// the plan's account gates it (RLS below).
export const installmentLines = finances.table(
  "installment_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    planId: uuid()
      .notNull()
      .references(() => installmentPlans.id, { onDelete: "cascade" }),
    seq: smallint().notNull(),
    // Date-only, interpreted in America/Bogota (RNF-06): a YYYY-MM-DD string end to end, never a JS Date.
    dueDate: date({ mode: "string" }).notNull(),
    amountCents: bigint({ mode: "number" }).notNull(),
    // The movement that settled this line in full, once allocated (RF-82); cleared if that movement is deleted.
    paidTransactionId: uuid().references(() => transactions.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("installment_lines_amount_positive", sql`${table.amountCents} > 0`),
    check("installment_lines_seq_positive", sql`${table.seq} > 0`),
    // A plan numbers its lines once.
    unique("installment_lines_plan_seq_unique").on(table.planId, table.seq),
    index("installment_lines_plan_id_idx").on(table.planId),
    index("installment_lines_paid_transaction_id_idx").on(table.paidTransactionId),
    // The oldest-first allocation walk reads a plan's lines in due order.
    index("installment_lines_plan_due_seq_idx").on(table.planId, table.dueDate, table.seq),
    // Readable and writable exactly when the plan's account is — an inline mirror of installment_plans.
    pgPolicy("installment_lines_select", {
      for: "select",
      to: authenticatedRole,
      using: sql`exists (select 1 from ${installmentPlans} p where p.id = ${table.planId} and private.can_read_account(p.account_id))`,
    }),
    pgPolicy("installment_lines_insert", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`exists (select 1 from ${installmentPlans} p where p.id = ${table.planId} and private.can_write_account(p.account_id))`,
    }),
    pgPolicy("installment_lines_update", {
      for: "update",
      to: authenticatedRole,
      using: sql`exists (select 1 from ${installmentPlans} p where p.id = ${table.planId} and private.can_write_account(p.account_id))`,
      withCheck: sql`exists (select 1 from ${installmentPlans} p where p.id = ${table.planId} and private.can_write_account(p.account_id))`,
    }),
    pgPolicy("installment_lines_delete", {
      for: "delete",
      to: authenticatedRole,
      using: sql`exists (select 1 from ${installmentPlans} p where p.id = ${table.planId} and private.can_write_account(p.account_id))`,
    }),
  ],
);

export type InstallmentLine = typeof installmentLines.$inferSelect;
export type NewInstallmentLine = typeof installmentLines.$inferInsert;
