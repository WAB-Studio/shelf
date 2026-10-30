import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  pgPolicy,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authenticatedRole, authUid } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { accounts } from "./accounts";
import { appUsers } from "./app-users";
import { groups } from "./groups";

// A virtual envelope (RF-76): a target amount and optional target date, scoped to a user or a group.
// Progress derives from its contributions and is never stored (RF-87).
export const savingsGoals = finances.table(
  "savings_goals",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Exactly one of these is set: a personal goal names its owner, a group goal names its group.
    ownerUserId: uuid().references(() => appUsers.id, { onDelete: "cascade" }),
    groupId: uuid().references(() => groups.id, { onDelete: "cascade" }),
    name: text().notNull(),
    targetAmountCents: bigint({ mode: "number" }).notNull(),
    targetDate: date({ mode: "string" }),
    // Display only: the account this goal's savings sit in; cleared if that account is deleted.
    accountId: uuid().references(() => accounts.id, { onDelete: "set null" }),
    // The stable per-scope import key (RF-52, RF-142): a re-import matches on it to update instead of duplicate.
    // Auto-filled to `id::text` by a trigger when omitted.
    externalRef: text(),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("savings_goals_external_ref_length", sql`length(${table.externalRef}) <= 200`),
    uniqueIndex("savings_goals_owner_external_ref_unique")
      .on(table.ownerUserId, table.externalRef)
      .where(sql`${table.externalRef} is not null`),
    uniqueIndex("savings_goals_group_external_ref_unique")
      .on(table.groupId, table.externalRef)
      .where(sql`${table.externalRef} is not null`),
    check("savings_goals_target_positive", sql`${table.targetAmountCents} > 0`),
    // A goal belongs to a user or a group, never both and never neither — mirrors categories.
    check(
      "savings_goals_owner_xor_group",
      sql`num_nonnulls(${table.ownerUserId}, ${table.groupId}) = 1`,
    ),
    check("savings_goals_name_length", sql`length(btrim(${table.name})) between 1 and 80`),
    index("savings_goals_owner_user_id_idx")
      .on(table.ownerUserId)
      .where(sql`${table.ownerUserId} is not null`),
    index("savings_goals_group_id_idx")
      .on(table.groupId)
      .where(sql`${table.groupId} is not null`),
    // Parent deletes check these foreign keys; without an index each one scans this table.
    index("savings_goals_account_id_idx")
      .on(table.accountId)
      .where(sql`${table.accountId} is not null`),
    // Universal read inside the group: your own personal goals, plus every goal of the group you belong to.
    pgPolicy("savings_goals_select_member", {
      for: "select",
      to: authenticatedRole,
      using: sql`(${authUid} = ${table.ownerUserId} or (select private.is_group_member(coalesce(${table.groupId}, private.owner_group_id(${table.ownerUserId})))))`,
    }),
    // A personal goal is written by its owner.
    pgPolicy("savings_goals_insert_personal", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${table.ownerUserId}`,
    }),
    // A group goal any member may write (not leader-only).
    pgPolicy("savings_goals_insert_group", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`(select private.is_group_member(${table.groupId}))`,
    }),
    pgPolicy("savings_goals_update_personal", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.ownerUserId}`,
      withCheck: sql`${authUid} = ${table.ownerUserId}`,
    }),
    pgPolicy("savings_goals_update_group", {
      for: "update",
      to: authenticatedRole,
      using: sql`(select private.is_group_member(${table.groupId}))`,
      withCheck: sql`(select private.is_group_member(${table.groupId}))`,
    }),
    pgPolicy("savings_goals_delete_personal", {
      for: "delete",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.ownerUserId}`,
    }),
    pgPolicy("savings_goals_delete_group", {
      for: "delete",
      to: authenticatedRole,
      using: sql`(select private.is_group_member(${table.groupId}))`,
    }),
  ],
);

export type SavingsGoal = typeof savingsGoals.$inferSelect;
export type NewSavingsGoal = typeof savingsGoals.$inferInsert;
