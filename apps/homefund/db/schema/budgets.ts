import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgPolicy,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authenticatedRole, authUid } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { accounts } from "./accounts";
import { appUsers } from "./app-users";
import { categories } from "./categories";
import { groups } from "./groups";
import { labels } from "./labels";

// A spending limit on a category for a repeating period (RF-71); scoped to a user or a group,
// optionally narrowed to one account and/or one label. Spent and remaining derive from splits (RF-72).
export const budgets = finances.table(
  "budgets",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Exactly one of these is set: a personal budget names its owner, a group budget names its group.
    ownerUserId: uuid().references(() => appUsers.id, { onDelete: "cascade" }),
    groupId: uuid().references(() => groups.id, { onDelete: "cascade" }),
    categoryId: uuid()
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    // Optional narrowing: the limit only counts splits on this account and/or this label.
    accountId: uuid().references(() => accounts.id, { onDelete: "restrict" }),
    labelId: uuid().references(() => labels.id, { onDelete: "restrict" }),
    period: text({ enum: ["monthly", "weekly", "yearly"] }).notNull(),
    limitCents: bigint({ mode: "number" }).notNull(),
    // The overspend alert threshold, a percentage of the limit (RF-73).
    thresholdPct: smallint().notNull(),
    name: text(),
    // The stable per-scope import key (RF-52, RF-142): a re-import matches on it to update instead of duplicate.
    // Auto-filled to `id::text` by a trigger when omitted.
    externalRef: text(),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("budgets_external_ref_length", sql`length(${table.externalRef}) <= 200`),
    uniqueIndex("budgets_owner_external_ref_unique")
      .on(table.ownerUserId, table.externalRef)
      .where(sql`${table.externalRef} is not null`),
    uniqueIndex("budgets_group_external_ref_unique")
      .on(table.groupId, table.externalRef)
      .where(sql`${table.externalRef} is not null`),
    check("budgets_limit_positive", sql`${table.limitCents} > 0`),
    check("budgets_threshold_pct_valid", sql`${table.thresholdPct} between 1 and 100`),
    // A budget belongs to a user or a group, never both and never neither — mirrors categories.
    check("budgets_owner_xor_group", sql`num_nonnulls(${table.ownerUserId}, ${table.groupId}) = 1`),
    check("budgets_period_valid", sql`${table.period} in ('monthly', 'weekly', 'yearly')`),
    check(
      "budgets_name_length",
      sql`${table.name} is null or length(btrim(${table.name})) <= 80`,
    ),
    index("budgets_owner_user_id_idx")
      .on(table.ownerUserId)
      .where(sql`${table.ownerUserId} is not null`),
    index("budgets_group_id_idx")
      .on(table.groupId)
      .where(sql`${table.groupId} is not null`),
    index("budgets_category_id_idx").on(table.categoryId),
    // Parent deletes check these foreign keys; without an index each one scans this table.
    index("budgets_account_id_idx")
      .on(table.accountId)
      .where(sql`${table.accountId} is not null`),
    index("budgets_label_id_idx")
      .on(table.labelId)
      .where(sql`${table.labelId} is not null`),
    // Universal read inside the group: your own personal budgets, plus every budget of the group you belong to.
    pgPolicy("budgets_select_member", {
      for: "select",
      to: authenticatedRole,
      using: sql`(${authUid} = ${table.ownerUserId} or (select private.is_group_member(coalesce(${table.groupId}, private.owner_group_id(${table.ownerUserId})))))`,
    }),
    // A personal budget is written by its owner.
    pgPolicy("budgets_insert_personal", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${table.ownerUserId}`,
    }),
    // A group budget any member may write (not leader-only).
    pgPolicy("budgets_insert_group", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`(select private.is_group_member(${table.groupId}))`,
    }),
    pgPolicy("budgets_update_personal", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.ownerUserId}`,
      withCheck: sql`${authUid} = ${table.ownerUserId}`,
    }),
    pgPolicy("budgets_update_group", {
      for: "update",
      to: authenticatedRole,
      using: sql`(select private.is_group_member(${table.groupId}))`,
      withCheck: sql`(select private.is_group_member(${table.groupId}))`,
    }),
    pgPolicy("budgets_delete_personal", {
      for: "delete",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.ownerUserId}`,
    }),
    pgPolicy("budgets_delete_group", {
      for: "delete",
      to: authenticatedRole,
      using: sql`(select private.is_group_member(${table.groupId}))`,
    }),
  ],
);

export type Budget = typeof budgets.$inferSelect;
export type NewBudget = typeof budgets.$inferInsert;
