import { sql } from "drizzle-orm";
import {
  check,
  pgPolicy,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { BASE_CURRENCY } from "@/lib/currency";
import { DEFAULT_LOCALE, LOCALES } from "@/lib/locales";

import { finances } from "./_schema";

// The application-side half of an auth user: what Supabase Auth does not store.
// The primary key is `auth.users.id` itself — a v4 uuid minted by Auth — so no
// surrogate key and no join stand between a session and its row.
export const appUsers = finances.table(
  "app_users",
  {
    id: uuid()
      .primaryKey()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    // `enum` types the column as the locale union without emitting a Postgres
    // enum or a check constraint: adding a language stays a catalogue edit.
    locale: text("locale", { enum: LOCALES }).notNull().default(DEFAULT_LOCALE),
    // What a budget, a goal or a planned payment of this person's own falls
    // back to when it names no account (RF-121). Typed loose like every other
    // currency column: the check is the shape of ISO 4217 and the short list a
    // person picks from is the interface's.
    settlementCurrency: text().notNull().default(BASE_CURRENCY),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "app_users_settlement_currency_iso",
      sql`${table.settlementCurrency} ~ '^[A-Z]{3}$'`,
    ),
    // `authUid` is `(select auth.uid())`: evaluated once per query, not once per row.
    pgPolicy("app_users_select_self", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.id}`,
    }),
    pgPolicy("app_users_insert_self", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${table.id}`,
    }),
    // `using` alone would let a user hand their row to someone else's id.
    pgPolicy("app_users_update_self", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.id}`,
      withCheck: sql`${authUid} = ${table.id}`,
    }),
    // No delete policy: rows die with the auth user through the cascade.
  ],
);

export type AppUser = typeof appUsers.$inferSelect;
export type NewAppUser = typeof appUsers.$inferInsert;
