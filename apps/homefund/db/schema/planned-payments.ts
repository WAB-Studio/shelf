import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  uniqueIndex,
  pgPolicy,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { authenticatedRole, authUid } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { accounts } from "./accounts";
import { appUsers } from "./app-users";
import { categories } from "./categories";
import { groups } from "./groups";
import { transactions } from "./transactions";

// A one-off deferred movement (RF-74): its accounts, amount, category and due date, with an optional
// reminder, kept distinct from recurring rules. Settling records the transaction and links it (RF-75).
export const plannedPayments = finances.table(
  "planned_payments",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Exactly one of these is set: a personal payment names its owner, a group payment names its group.
    // The scope is derived from the accounts, never chosen by the user — mirrors transactions.
    ownerUserId: uuid().references(() => appUsers.id, { onDelete: "restrict" }),
    groupId: uuid().references(() => groups.id, { onDelete: "cascade" }),
    fromAccountId: uuid().references(() => accounts.id, { onDelete: "restrict" }),
    toAccountId: uuid().references(() => accounts.id, { onDelete: "restrict" }),
    amountCents: bigint({ mode: "number" }).notNull(),
    categoryId: uuid().references(() => categories.id, { onDelete: "restrict" }),
    // Date-only, interpreted in America/Bogota (RNF-06): a YYYY-MM-DD string end to end, never a JS Date.
    dueDate: date({ mode: "string" }).notNull(),
    remindOn: date({ mode: "string" }),
    description: text(),
    status: text({ enum: ["pending", "done", "cancelled"] })
      .notNull()
      .default("pending"),
    // The transaction this payment settled into, once hand-settled (RF-75); cleared if that movement is deleted.
    settledTransactionId: uuid().references(() => transactions.id, { onDelete: "set null" }),
    createdBy: uuid()
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("planned_payments_amount_positive", sql`${table.amountCents} > 0`),
    // At least one account, so the scope and the movement's direction can be derived — mirrors transactions.
    check(
      "planned_payments_at_least_one_account",
      sql`num_nonnulls(${table.fromAccountId}, ${table.toAccountId}) >= 1`,
    ),
    // A transfer names two different accounts (RF-101) — the same rule the movement it settles into keeps.
    check(
      "planned_payments_accounts_distinct",
      sql`${table.fromAccountId} is distinct from ${table.toAccountId}`,
    ),
    check(
      "planned_payments_owner_xor_group",
      sql`num_nonnulls(${table.ownerUserId}, ${table.groupId}) = 1`,
    ),
    check(
      "planned_payments_status_valid",
      sql`${table.status} in ('pending', 'done', 'cancelled')`,
    ),
    // A reminder never falls after the payment is due.
    check(
      "planned_payments_remind_on_before_due",
      sql`${table.remindOn} is null or ${table.remindOn} <= ${table.dueDate}`,
    ),
    check("planned_payments_description_length", sql`length(${table.description}) <= 200`),
    index("planned_payments_owner_user_id_idx")
      .on(table.ownerUserId)
      .where(sql`${table.ownerUserId} is not null`),
    index("planned_payments_group_id_idx")
      .on(table.groupId)
      .where(sql`${table.groupId} is not null`),
    index("planned_payments_due_date_idx").on(table.dueDate),
    // One movement settles one payment: settle inserts its own (oleada-7 M11b, Q551).
    uniqueIndex("planned_payments_settled_transaction_id_unique").on(table.settledTransactionId),
    // Parent deletes check these foreign keys; without an index each one scans this table.
    index("planned_payments_from_account_id_idx")
      .on(table.fromAccountId)
      .where(sql`${table.fromAccountId} is not null`),
    index("planned_payments_to_account_id_idx")
      .on(table.toAccountId)
      .where(sql`${table.toAccountId} is not null`),
    index("planned_payments_category_id_idx")
      .on(table.categoryId)
      .where(sql`${table.categoryId} is not null`),
    index("planned_payments_created_by_idx")
      .on(table.createdBy)
      .where(sql`${table.createdBy} is not null`),
    // Universal read inside the group: your own personal payments, plus every payment of the group you belong to.
    pgPolicy("planned_payments_select_member", {
      for: "select",
      to: authenticatedRole,
      using: sql`(${authUid} = ${table.ownerUserId} or (select private.is_group_member(coalesce(${table.groupId}, private.owner_group_id(${table.ownerUserId})))))`,
    }),
    // Write is bounded to own-or-shared accounts (RF-62), the same as the transaction it will settle into.
    pgPolicy("planned_payments_insert_writable", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`(select private.can_write_transaction(${table.fromAccountId}, ${table.toAccountId}))`,
    }),
    pgPolicy("planned_payments_update_writable", {
      for: "update",
      to: authenticatedRole,
      using: sql`(select private.can_write_transaction(${table.fromAccountId}, ${table.toAccountId}))`,
      withCheck: sql`(select private.can_write_transaction(${table.fromAccountId}, ${table.toAccountId}))`,
    }),
    pgPolicy("planned_payments_delete_writable", {
      for: "delete",
      to: authenticatedRole,
      using: sql`(select private.can_write_transaction(${table.fromAccountId}, ${table.toAccountId}))`,
    }),
  ],
);

export type PlannedPayment = typeof plannedPayments.$inferSelect;
