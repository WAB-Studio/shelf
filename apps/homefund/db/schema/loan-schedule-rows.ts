import { sql } from "drizzle-orm";
import { bigint, check, date, pgPolicy, smallint, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { accounts } from "./accounts";

// One row of the payment schedule a bank prints for an instalment loan: what falls due that day, split into
// capital, interest and insurance, and the capital still owed after it. Only what the bank printed is stored;
// whether a row is paid, the next one and what is left derive from the loan's movements and are never kept.
// It has no scope of its own: the loan's scope gates it. A schedule is replaced whole, so no row is updated.
export const loanScheduleRows = finances.table(
  "loan_schedule_rows",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    // The bank's own number, from 1.
    number: smallint().notNull(),
    dueOn: date({ mode: "string" }).notNull(),
    principalCents: bigint({ mode: "number" }).notNull(),
    interestCents: bigint({ mode: "number" }).notNull(),
    insuranceCents: bigint({ mode: "number" }).notNull(),
    totalCents: bigint({ mode: "number" }).notNull(),
    // The capital still owed once this row is paid.
    remainingCents: bigint({ mode: "number" }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("loan_schedule_rows_number_valid", sql`${table.number} between 1 and 600`),
    check(
      "loan_schedule_rows_amounts_non_negative",
      sql`${table.principalCents} >= 0 and ${table.interestCents} >= 0 and ${table.insuranceCents} >= 0 and ${table.remainingCents} >= 0`,
    ),
    check("loan_schedule_rows_total_adds_up", sql`${table.totalCents} = ${table.principalCents} + ${table.interestCents} + ${table.insuranceCents}`),
    check("loan_schedule_rows_total_positive", sql`${table.totalCents} > 0`),
    unique("loan_schedule_rows_number_unique").on(table.accountId, table.number),
    unique("loan_schedule_rows_due_unique").on(table.accountId, table.dueOn),
    pgPolicy("loan_schedule_rows_select", {
      for: "select",
      to: authenticatedRole,
      using: sql`(select private.can_read_account(${table.accountId}))`,
    }),
    pgPolicy("loan_schedule_rows_insert", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`(select private.can_write_account(${table.accountId}))`,
    }),
    pgPolicy("loan_schedule_rows_delete", {
      for: "delete",
      to: authenticatedRole,
      using: sql`(select private.can_write_account(${table.accountId}))`,
    }),
  ],
);

export type LoanScheduleRow = typeof loanScheduleRows.$inferSelect;
