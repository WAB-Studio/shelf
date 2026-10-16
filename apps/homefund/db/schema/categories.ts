import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgPolicy,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authenticatedRole, authUid } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { appUsers } from "./app-users";
import { groups } from "./groups";

// How a transaction is classified; RF-63 nests one level of subcategory and scopes each to a user or a group.
export const categories = finances.table(
  "categories",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Exactly one of these is set: a personal category names its owner, a group category names its group.
    ownerUserId: uuid().references(() => appUsers.id, { onDelete: "cascade" }),
    groupId: uuid().references(() => groups.id, { onDelete: "cascade" }),
    parentId: uuid(),
    name: text().notNull(),
    kind: text({ enum: ["expense", "income"] }).notNull(),
    color: text(),
    // The stable per-scope import key (RF-51): a re-import matches on it to update instead of duplicate.
    // Auto-filled to `id::text` by a trigger when omitted; a webhook or upsert value survives untouched.
    externalRef: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("categories_name_length", sql`length(btrim(${table.name})) between 1 and 80`),
    check("categories_kind_valid", sql`${table.kind} in ('expense', 'income')`),
    // A category belongs to a user or a group, never both and never neither — mirrors accounts.
    check(
      "categories_owner_xor_group",
      sql`num_nonnulls(${table.ownerUserId}, ${table.groupId}) = 1`,
    ),
    // What lets a subcategory's foreign key pin it to the same group as its parent.
    unique("categories_id_group_id_unique").on(table.id, table.groupId),
    foreignKey({
      columns: [table.parentId, table.groupId],
      foreignColumns: [table.id, table.groupId],
    }).onDelete("cascade"),
    check("categories_external_ref_length", sql`length(${table.externalRef}) <= 200`),
    index("categories_group_id_idx").on(table.groupId),
    index("categories_owner_user_id_idx").on(table.ownerUserId),
    index("categories_parent_id_idx").on(table.parentId),
    // `external_ref` is unique within a scope, so re-importing the same row updates instead of duplicating (RF-51).
    uniqueIndex("categories_owner_external_ref_unique")
      .on(table.ownerUserId, table.externalRef)
      .where(sql`${table.externalRef} is not null`),
    uniqueIndex("categories_group_external_ref_unique")
      .on(table.groupId, table.externalRef)
      .where(sql`${table.externalRef} is not null`),
    // Universal read inside the group: your own personal categories, plus every category of the group you belong to.
    pgPolicy("categories_select_member", {
      for: "select",
      to: authenticatedRole,
      using: sql`(${authUid} = ${table.ownerUserId} or (select private.is_group_member(coalesce(${table.groupId}, private.owner_group_id(${table.ownerUserId})))))`,
    }),
    // A personal category is written by its owner.
    pgPolicy("categories_insert_personal", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${table.ownerUserId}`,
    }),
    // A group category is managed by the group's leader (RF-57).
    pgPolicy("categories_insert_group", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`(select private.is_group_leader(${table.groupId}))`,
    }),
    pgPolicy("categories_update_personal", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.ownerUserId}`,
      withCheck: sql`${authUid} = ${table.ownerUserId}`,
    }),
    pgPolicy("categories_update_group", {
      for: "update",
      to: authenticatedRole,
      using: sql`(select private.is_group_leader(${table.groupId}))`,
      withCheck: sql`(select private.is_group_leader(${table.groupId}))`,
    }),
    pgPolicy("categories_delete_personal", {
      for: "delete",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.ownerUserId}`,
    }),
    pgPolicy("categories_delete_group", {
      for: "delete",
      to: authenticatedRole,
      using: sql`(select private.is_group_leader(${table.groupId}))`,
    }),
  ],
);

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
