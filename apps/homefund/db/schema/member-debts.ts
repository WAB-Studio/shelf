import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  pgPolicy,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { appUsers } from "./app-users";
import { groupMembers } from "./group-members";
import { groups } from "./groups";

// What one member of a fund owes another (RF-183): a debt adds to it, a payment takes from it. The
// pending figure per pair and currency is summed on read and never stored. Both members belong to
// the row's fund: each reference carries `group_id`, so a member of another fund cannot be named.
export const memberDebts = finances.table(
  "member_debts",
  {
    id: uuid().primaryKey().defaultRandom(),
    groupId: uuid()
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    kind: text({ enum: ["debt", "payment"] }).notNull(),
    debtorMemberId: uuid().notNull(),
    creditorMemberId: uuid().notNull(),
    amountCents: bigint({ mode: "number" }).notNull(),
    currency: text().notNull(),
    occurredOn: date({ mode: "string" }).notNull(),
    description: text(),
    // Stamped by the column default from `auth.uid()`; no grant lets a caller name it.
    createdBy: uuid()
      .notNull()
      .default(sql`auth.uid()`)
      .references(() => appUsers.id, { onDelete: "restrict" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("member_debts_kind_valid", sql`${table.kind} in ('debt', 'payment')`),
    check("member_debts_amount_positive", sql`${table.amountCents} > 0`),
    check("member_debts_currency_iso", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("member_debts_two_members", sql`${table.debtorMemberId} <> ${table.creditorMemberId}`),
    check("member_debts_description_length", sql`length(btrim(${table.description})) between 1 and 200`),
    foreignKey({
      name: "member_debts_debtor_in_fund_fk",
      columns: [table.debtorMemberId, table.groupId],
      foreignColumns: [groupMembers.id, groupMembers.groupId],
    }),
    foreignKey({
      name: "member_debts_creditor_in_fund_fk",
      columns: [table.creditorMemberId, table.groupId],
      foreignColumns: [groupMembers.id, groupMembers.groupId],
    }),
    index("member_debts_group_id_idx").on(table.groupId),
    index("member_debts_debtor_member_id_idx").on(table.debtorMemberId),
    index("member_debts_creditor_member_id_idx").on(table.creditorMemberId),
    index("member_debts_created_by_idx").on(table.createdBy),
    pgPolicy("member_debts_select_member", {
      for: "select",
      to: authenticatedRole,
      using: sql`(select private.is_group_member(${table.groupId}))`,
    }),
    pgPolicy("member_debts_insert_member", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`(select private.is_group_member(${table.groupId}))`,
    }),
    pgPolicy("member_debts_delete_member", {
      for: "delete",
      to: authenticatedRole,
      using: sql`(select private.is_group_member(${table.groupId}))`,
    }),
  ],
);

export type MemberDebt = typeof memberDebts.$inferSelect;
