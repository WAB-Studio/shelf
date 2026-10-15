import { sql } from "drizzle-orm";
import { bigint, date, index, pgPolicy, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { accounts } from "./accounts";
import { appUsers } from "./app-users";

// What a person counted an account really held on a day (RF-137). Final: no UPDATE, no DELETE —
// a mistake is corrected by reconciling again. Its gap against the ledger is booked by the database
// as the one movement marked with this id (`transactions.reconciliation_id`); a zero gap books none.
// The derived balance is never stored here: it reads back as `counted − gap`. No scope of its own —
// the account's scope gates it.
export const accountReconciliations = finances.table(
  "account_reconciliations",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    // Date-only, interpreted in America/Bogota (RNF-06): a YYYY-MM-DD string end to end.
    reconciledOn: date({ mode: "string" }).notNull(),
    // A person's input, signed like the account (a liability's debt is negative), in the minor unit
    // of the account's settlement currency.
    countedBalanceCents: bigint({ mode: "number" }).notNull(),
    // Set by trigger from `auth.uid()`; no grant lets a caller name it.
    createdBy: uuid()
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The per-account history, newest first, and the latest day the insert trigger compares against.
    index("account_reconciliations_account_day_idx").on(
      table.accountId,
      table.reconciledOn.desc(),
      table.createdAt.desc(),
    ),
    index("account_reconciliations_created_by_idx").on(table.createdBy),
    pgPolicy("account_reconciliations_select", {
      for: "select",
      to: authenticatedRole,
      using: sql`(select private.can_read_account(${table.accountId}))`,
    }),
    pgPolicy("account_reconciliations_insert", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`(select private.can_write_account(${table.accountId}))`,
    }),
    // No UPDATE and no DELETE policy: a reconciliation leaves only with its account, down the cascade.
  ],
);

export type AccountReconciliation = typeof accountReconciliations.$inferSelect;
export type NewAccountReconciliation = typeof accountReconciliations.$inferInsert;
