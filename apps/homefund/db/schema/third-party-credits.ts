import { sql } from "drizzle-orm";
import { bigint, check, pgPolicy, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { accounts } from "./accounts";

// A credit in the person's name that somebody else pays (RF-211): the liability it is, the «Me debe» asset
// the payer's debt sits in, who the payer is, and what the lender asks each month. Only the link is stored;
// what is still owed, what the payer paid and the month's state derive from the two accounts' movements.
// It has no scope of its own: the liability's scope gates it, and the receivable shares that scope.
export const thirdPartyCredits = finances.table(
  "third_party_credits",
  {
    id: uuid().primaryKey().defaultRandom(),
    liabilityAccountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    receivableAccountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    personName: text().notNull(),
    // What the lender asks each month and the day it is due, both optional and both the lender's.
    installmentCents: bigint({ mode: "number" }),
    dueDay: smallint(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("third_party_credits_person_name_length", sql`length(btrim(${table.personName})) between 1 and 80`),
    check("third_party_credits_installment_positive", sql`${table.installmentCents} is null or ${table.installmentCents} > 0`),
    check("third_party_credits_due_day_valid", sql`${table.dueDay} is null or ${table.dueDay} between 1 and 31`),
    check("third_party_credits_two_accounts", sql`${table.liabilityAccountId} <> ${table.receivableAccountId}`),
    // One payer per credit, and a receivable follows one credit: its transfers are that credit's story.
    uniqueIndex("third_party_credits_liability_unique").on(table.liabilityAccountId),
    uniqueIndex("third_party_credits_receivable_unique").on(table.receivableAccountId),
    pgPolicy("third_party_credits_select", {
      for: "select",
      to: authenticatedRole,
      using: sql`(select private.can_read_account(${table.liabilityAccountId}))`,
    }),
    pgPolicy("third_party_credits_insert", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`((select private.can_write_account(${table.liabilityAccountId})) and (select private.can_write_account(${table.receivableAccountId})))`,
    }),
    pgPolicy("third_party_credits_update", {
      for: "update",
      to: authenticatedRole,
      using: sql`(select private.can_write_account(${table.liabilityAccountId}))`,
      withCheck: sql`(select private.can_write_account(${table.liabilityAccountId}))`,
    }),
    pgPolicy("third_party_credits_delete", {
      for: "delete",
      to: authenticatedRole,
      using: sql`(select private.can_write_account(${table.liabilityAccountId}))`,
    }),
  ],
);

export type ThirdPartyCredit = typeof thirdPartyCredits.$inferSelect;
