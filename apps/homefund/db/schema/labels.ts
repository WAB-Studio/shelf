import { sql } from "drizzle-orm";
import { check, index, pgPolicy, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { appUsers } from "./app-users";
import { groups } from "./groups";

// A free tag on a movement, independent of category (RF-70); scoped to a user or a group like a category.
export const labels = finances.table(
  "labels",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Exactly one of these is set: a personal label names its owner, a group label names its group.
    ownerUserId: uuid().references(() => appUsers.id, { onDelete: "cascade" }),
    groupId: uuid().references(() => groups.id, { onDelete: "cascade" }),
    name: text().notNull(),
    color: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("labels_name_length", sql`length(btrim(${table.name})) between 1 and 80`),
    // A label belongs to a user or a group, never both and never neither — mirrors categories.
    check("labels_owner_xor_group", sql`num_nonnulls(${table.ownerUserId}, ${table.groupId}) = 1`),
    index("labels_group_id_idx").on(table.groupId),
    index("labels_owner_user_id_idx").on(table.ownerUserId),
    // Universal read inside the group: your own personal labels, plus every label of the group you belong to.
    pgPolicy("labels_select_member", {
      for: "select",
      to: authenticatedRole,
      using: sql`(${authUid} = ${table.ownerUserId} or (select private.is_group_member(coalesce(${table.groupId}, private.owner_group_id(${table.ownerUserId})))))`,
    }),
    // A personal label is written by its owner.
    pgPolicy("labels_insert_personal", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${table.ownerUserId}`,
    }),
    // A group label is managed by the group's leader (RF-57).
    pgPolicy("labels_insert_group", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`(select private.is_group_leader(${table.groupId}))`,
    }),
    pgPolicy("labels_update_personal", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.ownerUserId}`,
      withCheck: sql`${authUid} = ${table.ownerUserId}`,
    }),
    pgPolicy("labels_update_group", {
      for: "update",
      to: authenticatedRole,
      using: sql`(select private.is_group_leader(${table.groupId}))`,
      withCheck: sql`(select private.is_group_leader(${table.groupId}))`,
    }),
    pgPolicy("labels_delete_personal", {
      for: "delete",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.ownerUserId}`,
    }),
    pgPolicy("labels_delete_group", {
      for: "delete",
      to: authenticatedRole,
      using: sql`(select private.is_group_leader(${table.groupId}))`,
    }),
  ],
);

export type Label = typeof labels.$inferSelect;
export type NewLabel = typeof labels.$inferInsert;
