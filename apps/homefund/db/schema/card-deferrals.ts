import { sql } from "drizzle-orm";
import { bigint, check, date, numeric, pgPolicy, smallint, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { accounts } from "./accounts";
import { appUsers } from "./app-users";

// A deferral as the issuer prints it on a card's statement (RF-258): what was deferred, into how many
// instalments, where it stands and at what rate. It is the bank's word and keeps no movement, unlike
// `deferrals` (RF-136), which a person confirms on a purchase they booked: an extension of term has no
// purchase to point at. Told apart by the authorization number within the card; a later statement
// replaces the figures in place, and an older one never overwrites a newer. What a month of it costs and
// what paying it off saves derive on read (`lib/card-deferral.ts`). The account's scope gates it.
export const cardDeferrals = finances.table(
  "card_deferrals",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    authorizationNumber: text().notNull(),
    description: text().notNull(),
    // The currency of the statement section it sits in; a card bills in pesos and dollars at once.
    currency: text().notNull(),
    originalAmountCents: bigint({ mode: "number" }).notNull(),
    instalments: smallint().notNull(),
    currentInstalment: smallint().notNull(),
    monthlyInstalmentCents: bigint({ mode: "number" }).notNull(),
    pendingBalanceCents: bigint({ mode: "number" }).notNull(),
    // Effective annual fraction, as `debt_terms.annual_rate`; 0 for an instalment plan with no interest.
    annualRate: numeric().notNull(),
    // The cut-off of the statement these figures were read from.
    statementOn: date({ mode: "string" }).notNull(),
    // Stamped by the column default from `auth.uid()`; no grant lets a caller name it.
    createdBy: uuid()
      .notNull()
      .default(sql`auth.uid()`)
      .references(() => appUsers.id, { onDelete: "restrict" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("card_deferrals_account_authorization_unique").on(table.accountId, table.authorizationNumber),
    check("card_deferrals_authorization_length", sql`length(btrim(${table.authorizationNumber})) between 1 and 40`),
    check("card_deferrals_description_length", sql`length(btrim(${table.description})) between 1 and 200`),
    check("card_deferrals_currency_shape", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("card_deferrals_original_positive", sql`${table.originalAmountCents} > 0`),
    check("card_deferrals_instalments_range", sql`${table.instalments} between 1 and 120`),
    check(
      "card_deferrals_current_instalment_range",
      sql`${table.currentInstalment} between 1 and ${table.instalments}`,
    ),
    check("card_deferrals_monthly_non_negative", sql`${table.monthlyInstalmentCents} >= 0`),
    check("card_deferrals_pending_non_negative", sql`${table.pendingBalanceCents} >= 0`),
    check("card_deferrals_rate_range", sql`${table.annualRate} >= 0 and ${table.annualRate} <= 2`),
    pgPolicy("card_deferrals_select", {
      for: "select",
      to: authenticatedRole,
      using: sql`(select private.can_read_account(${table.accountId}))`,
    }),
    pgPolicy("card_deferrals_insert", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`(select private.can_write_account(${table.accountId}))`,
    }),
    pgPolicy("card_deferrals_update", {
      for: "update",
      to: authenticatedRole,
      using: sql`(select private.can_write_account(${table.accountId}))`,
      withCheck: sql`(select private.can_write_account(${table.accountId}))`,
    }),
    pgPolicy("card_deferrals_delete", {
      for: "delete",
      to: authenticatedRole,
      using: sql`(select private.can_write_account(${table.accountId}))`,
    }),
  ],
);

export type CardDeferral = typeof cardDeferrals.$inferSelect;
export type NewCardDeferral = typeof cardDeferrals.$inferInsert;
