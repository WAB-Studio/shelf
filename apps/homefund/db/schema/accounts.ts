import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
import { appUsers } from "./app-users";
import { groups } from "./groups";

// Where money sits: an asset or a liability, owned by a user XOR held by a group.
export const accounts = finances.table(
  "accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Exactly one of these is set: a personal account names its owner, a group account names its group.
    ownerUserId: uuid().references(() => appUsers.id, { onDelete: "restrict" }),
    groupId: uuid().references(() => groups.id, { onDelete: "cascade" }),
    // A group account any member may write; a personal account stays owner-only (accounts_personal_not_shared).
    isShared: boolean().notNull().default(false),
    name: text().notNull(),
    kind: text({ enum: ["asset", "liability"] }).notNull(),
    // The durable marker of what the account is: a bank account, physical cash, or a card. A cash
    // account (RF-56) is `subtype = 'cash'`. `bank`/`card` follow the kind, so a caller that names
    // neither has one derived by `set_account_subtype`; the default lets it be omitted.
    subtype: text({ enum: ["bank", "cash", "card"] }).notNull().default("bank"),
    institution: text(),
    lastFour: text(),
    // The ISO 4217 code the account settles in (RF-121): what the issuer bills, what the bank holds.
    // Any code is accepted; the short list a person picks from lives in the interface.
    settlementCurrency: text().notNull().default("COP"),
    // The opening balance only (RNF-05), in the minor unit of `settlement_currency`. No running
    // balance column exists anywhere (RNF-07).
    initialBalanceCents: bigint({ mode: "number" }).notNull().default(0),
    initialBalanceOn: date().notNull(),
    archivedAt: timestamp({ withTimezone: true }),
    // The stable per-scope import key (RF-51): a re-import matches on it to update instead of duplicate.
    // Auto-filled to `id::text` by a trigger when omitted; a webhook or upsert value survives untouched.
    externalRef: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("accounts_name_length", sql`length(btrim(${table.name})) between 1 and 80`),
    check("accounts_kind_valid", sql`${table.kind} in ('asset', 'liability')`),
    check("accounts_subtype_valid", sql`${table.subtype} in ('bank', 'cash', 'card')`),
    // Cash and bank hold value (asset); a card is money owed (liability). The subtype pins the kind.
    check(
      "accounts_subtype_kind",
      sql`(${table.subtype} in ('cash', 'bank') and ${table.kind} = 'asset') or (${table.subtype} = 'card' and ${table.kind} = 'liability')`,
    ),
    // A liability's opening balance is stored negative; an asset's is stored non-negative.
    check(
      "accounts_initial_balance_sign",
      sql`(${table.kind} = 'asset' and ${table.initialBalanceCents} >= 0) or (${table.kind} = 'liability' and ${table.initialBalanceCents} <= 0)`,
    ),
    // An account belongs to a user or a group, never both and never neither — mirrors categories.
    check("accounts_owner_xor_group", sql`num_nonnulls(${table.ownerUserId}, ${table.groupId}) = 1`),
    // A personal account is never shared; only a group account carries is_shared.
    check("accounts_personal_not_shared", sql`${table.ownerUserId} is null or ${table.isShared} = false`),
    check("accounts_external_ref_length", sql`length(${table.externalRef}) <= 200`),
    check("accounts_last_four_digits", sql`${table.lastFour} is null or ${table.lastFour} ~ '^[0-9]{4}$'`),
    // The shape of ISO 4217, not a list of codes: which ones a person may pick is an interface question.
    check("accounts_settlement_currency_iso", sql`${table.settlementCurrency} ~ '^[A-Z]{3}$'`),
    index("accounts_group_id_idx").on(table.groupId),
    index("accounts_owner_user_id_idx").on(table.ownerUserId),
    // `external_ref` is unique within a scope, so re-importing the same row updates instead of duplicating (RF-51).
    uniqueIndex("accounts_owner_external_ref_unique")
      .on(table.ownerUserId, table.externalRef)
      .where(sql`${table.externalRef} is not null`),
    uniqueIndex("accounts_group_external_ref_unique")
      .on(table.groupId, table.externalRef)
      .where(sql`${table.externalRef} is not null`),
    // Universal read inside the group: your own personal account, plus every account of the group you belong to.
    pgPolicy("accounts_select_group", {
      for: "select",
      to: authenticatedRole,
      using: sql`(${table.ownerUserId} = ${authUid} or (select private.is_group_member(coalesce(${table.groupId}, private.owner_group_id(${table.ownerUserId})))))`,
    }),
    // Write is bounded to own-or-shared; the leader holds no write exception here.
    // The INSERT WITH CHECK reads the NEW row's own columns inline: can_write_account looks the row up by
    // id, which the not-yet-visible NEW row fails, so it mirrors the group_members/categories inline pattern.
    pgPolicy("accounts_insert_writable", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`(${table.ownerUserId} = ${authUid} or (${table.isShared} and (select private.is_group_member(${table.groupId}))))`,
    }),
    pgPolicy("accounts_update_writable", {
      for: "update",
      to: authenticatedRole,
      using: sql`(select private.can_write_account(${table.id}))`,
      withCheck: sql`(select private.can_write_account(${table.id}))`,
    }),
    // The leader re-shares a group account a leader un-shared; `can_write_account` is false for it.
    pgPolicy("accounts_update_leader_reshare", {
      for: "update",
      to: authenticatedRole,
      using: sql`(${table.groupId} is not null and not ${table.isShared} and (select private.is_group_leader(${table.groupId})))`,
      withCheck: sql`(${table.groupId} is not null and (select private.is_group_leader(${table.groupId})))`,
    }),
    pgPolicy("accounts_delete_writable", {
      for: "delete",
      to: authenticatedRole,
      using: sql`(select private.can_write_account(${table.id}))`,
    }),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
