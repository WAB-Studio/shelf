import { sql } from "drizzle-orm";
import { check, index, pgPolicy, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { accounts } from "./accounts";
import { appUsers } from "./app-users";
import { categories } from "./categories";

// A number a bank message names (an account, a phone), remembered with a name and what it is (RF-189).
// Personal: it is matched against the person's own deliveries. `identifier` holds digits only; a notice
// shows the whole number or its tail, so a match is a suffix, never an equality (`db/queries/recipients.ts`).
// The references are set null on delete: a recipient outlives the account or category it pointed at.
export const recipients = finances.table(
  "recipients",
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerUserId: uuid()
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    identifier: text().notNull(),
    name: text().notNull(),
    kind: text({ enum: ["own_account", "person", "payee"] }).notNull(),
    // `own_account`: the person's account the number belongs to. `person`: their debt account, if any.
    accountId: uuid().references(() => accounts.id, { onDelete: "set null" }),
    // `payee`: the category an expense to it takes by default.
    categoryId: uuid().references(() => categories.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("recipients_identifier_digits", sql`${table.identifier} ~ '^[0-9]{4,20}$'`),
    check("recipients_name_length", sql`length(btrim(${table.name})) between 1 and 80`),
    check("recipients_kind_valid", sql`${table.kind} in ('own_account', 'person', 'payee')`),
    check(
      "recipients_account_by_kind",
      sql`${table.accountId} is null or ${table.kind} in ('own_account', 'person')`,
    ),
    check("recipients_category_by_kind", sql`${table.categoryId} is null or ${table.kind} = 'payee'`),
    uniqueIndex("recipients_owner_identifier_unique").on(table.ownerUserId, table.identifier),
    index("recipients_account_id_idx")
      .on(table.accountId)
      .where(sql`${table.accountId} is not null`),
    index("recipients_category_id_idx")
      .on(table.categoryId)
      .where(sql`${table.categoryId} is not null`),
    pgPolicy("recipients_select", {
      for: "select",
      to: authenticatedRole,
      using: sql`${table.ownerUserId} = ${authUid}`,
    }),
    pgPolicy("recipients_insert", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${table.ownerUserId} = ${authUid}`,
    }),
    pgPolicy("recipients_update", {
      for: "update",
      to: authenticatedRole,
      using: sql`${table.ownerUserId} = ${authUid}`,
      withCheck: sql`${table.ownerUserId} = ${authUid}`,
    }),
    pgPolicy("recipients_delete", {
      for: "delete",
      to: authenticatedRole,
      using: sql`${table.ownerUserId} = ${authUid}`,
    }),
  ],
);

export type Recipient = typeof recipients.$inferSelect;
