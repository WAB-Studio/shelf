import { sql } from "drizzle-orm";
import { check, index, pgPolicy, smallint, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { accounts } from "./accounts";
import { appUsers } from "./app-users";
import { transactions } from "./transactions";

// A purchase on a liability that the issuer deferred into `instalments` monthly parts (RF-136). The
// row only says the purchase is deferred: its whole amount stays in the balance, and the monthly
// share, the current instalment and the extinguishing are derived on read (`lib/deferral.ts`).
// The account's scope gates it. No UPDATE: changing the count is a delete and a new insert.
export const deferrals = finances.table(
  "deferrals",
  {
    id: uuid().primaryKey().defaultRandom(),
    transactionId: uuid()
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    // The purchase's liability leg. Restrict, as every other reference to `accounts` a movement carries.
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    instalments: smallint().notNull(),
    // Stamped by the column default from `auth.uid()`; no grant lets a caller name it.
    createdBy: uuid()
      .notNull()
      .default(sql`auth.uid()`)
      .references(() => appUsers.id, { onDelete: "restrict" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("deferrals_transaction_unique").on(table.transactionId),
    check("deferrals_instalments_range", sql`${table.instalments} between 2 and 72`),
    index("deferrals_account_id_idx").on(table.accountId),
    index("deferrals_created_by_idx").on(table.createdBy),
    pgPolicy("deferrals_select", {
      for: "select",
      to: authenticatedRole,
      using: sql`(select private.can_read_account(${table.accountId}))`,
    }),
    pgPolicy("deferrals_insert", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`(select private.can_write_account(${table.accountId}))`,
    }),
    pgPolicy("deferrals_delete", {
      for: "delete",
      to: authenticatedRole,
      using: sql`(select private.can_write_account(${table.accountId}))`,
    }),
  ],
);

export type Deferral = typeof deferrals.$inferSelect;
export type NewDeferral = typeof deferrals.$inferInsert;
