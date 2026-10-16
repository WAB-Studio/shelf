import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  pgPolicy,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { accounts } from "./accounts";

// Any account's statement history (RF-129, RF-130): one immutable snapshot per period carrying what
// the statement printed. Materialised for a past period and never rewritten — no UPDATE policy.
// Every printed figure but the closing balance is nullable: not every institution prints all of them,
// and a null says "not printed", which a zero would misreport. No scope of its own — the account's
// scope gates it.
export const accountStatements = finances.table(
  "account_statements",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    // Date-only bounds, interpreted in America/Bogota (RNF-06): YYYY-MM-DD strings, never a JS Date.
    periodStart: date({ mode: "string" }).notNull(),
    cutOffDate: date({ mode: "string" }).notNull(),
    // Only a liability's statement demands a payment; an asset's carries no due date.
    paymentDueDate: date({ mode: "string" }),
    openingBalanceCents: bigint({ mode: "number" }),
    // The one persisted balance figure, signed like the account, as the statement printed it at the
    // cut-off (RNF-07 stands: no running balance column — this is a snapshot, never kept in sync with
    // later movements). Its distance from the derived balance is computed on read and never stored.
    closingBalanceCents: bigint({ mode: "number" }).notNull(),
    creditsCents: bigint({ mode: "number" }),
    debitsCents: bigint({ mode: "number" }),
    minimumPaymentCents: bigint({ mode: "number" }),
    // What the statement charged, never what the app estimated (RF-130).
    interestChargedCents: bigint({ mode: "number" }),
    feesChargedCents: bigint({ mode: "number" }),
    // How the snapshot got here: cut by the app from movements, or read off an imported statement.
    source: text().notNull().default("recorded"),
    closedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "account_statements_period_before_cut_off",
      sql`${table.periodStart} <= ${table.cutOffDate}`,
    ),
    check(
      "account_statements_due_after_cut_off",
      sql`${table.paymentDueDate} is null or ${table.paymentDueDate} >= ${table.cutOffDate}`,
    ),
    check(
      "account_statements_minimum_non_negative",
      sql`${table.minimumPaymentCents} is null or ${table.minimumPaymentCents} >= 0`,
    ),
    check("account_statements_source_valid", sql`${table.source} in ('recorded', 'imported')`),
    // One statement per account per cut-off.
    unique("account_statements_account_cut_off_unique").on(table.accountId, table.cutOffDate),
    // Readable and writable exactly when the account it belongs to is — the scope is the account's.
    pgPolicy("account_statements_select", {
      for: "select",
      to: authenticatedRole,
      using: sql`(select private.can_read_account(${table.accountId}))`,
    }),
    pgPolicy("account_statements_insert", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`(select private.can_write_account(${table.accountId}))`,
    }),
    // No UPDATE policy: a statement is an immutable historical snapshot.
    // No DELETE policy either: a statement leaves only with its account, down the foreign key's cascade.
  ],
);

export type AccountStatement = typeof accountStatements.$inferSelect;
export type NewAccountStatement = typeof accountStatements.$inferInsert;
