import { sql } from "drizzle-orm";
import { check, pgPolicy, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import { finances } from "./_schema";

// The optional shared pot: a user may belong to one, and its `cash_mode` sets how cash is held (RF-56).
export const groups = finances.table(
  "groups",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    // The ISO 4217 code the group reports in (RF-121); an account still settles in its own.
    currency: text().notNull().default("COP"),
    // 'shared' is one group cash account; 'per_member' is one cash account per member (RF-68).
    cashMode: text({ enum: ["shared", "per_member"] }).notNull().default("shared"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("groups_name_length", sql`length(btrim(${table.name})) between 1 and 80`),
    check("groups_cash_mode_valid", sql`${table.cashMode} in ('shared', 'per_member')`),
    // The shape of ISO 4217, not a list of codes: which ones a person may pick is an interface question.
    check("groups_currency_iso", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    // Membership, not ownership, gates read access — see RF-58.
    pgPolicy("groups_select_member", {
      for: "select",
      to: authenticatedRole,
      using: sql`(select private.is_group_member(${table.id}))`,
    }),
    // Anyone signed in may start a group; RF-59 makes them its leader on the members insert.
    pgPolicy("groups_insert_any", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`true`,
    }),
    // The `GRANT UPDATE (name, cash_mode)` has stood since the first migration with no policy to
    // serve it, so every rename answered UPDATE 0. The grant bounds the columns, this bounds the row.
    pgPolicy("groups_update_leader", {
      for: "update",
      to: authenticatedRole,
      using: sql`(select private.is_group_leader(${table.id}))`,
      withCheck: sql`(select private.is_group_leader(${table.id}))`,
    }),
  ],
);

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
