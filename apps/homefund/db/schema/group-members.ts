import { sql } from "drizzle-orm";
import {
  check,
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

// A person in a group, with or without a login (RF-07): `user_id` is null until they accept an invite.
export const groupMembers = finances.table(
  "group_members",
  {
    id: uuid().primaryKey().defaultRandom(),
    groupId: uuid()
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: uuid().references(() => appUsers.id, { onDelete: "set null" }),
    // RF-06: the email an invite pends on until the invited person signs in and claims the row.
    inviteEmail: text(),
    name: text().notNull(),
    role: text({ enum: ["leader", "member"] }).notNull().default("member"),
    // The stable per-scope import key (RF-51): a re-import matches on it to update instead of duplicate.
    // Auto-filled to `id::text` by a trigger when omitted; a webhook or upsert value survives untouched.
    externalRef: text(),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("group_members_name_length", sql`length(btrim(${table.name})) between 1 and 80`),
    check("group_members_role_valid", sql`${table.role} in ('leader', 'member')`),
    // The §2 invariant "only a member with a user can be leader", as a constraint.
    check("group_members_leader_has_user", sql`${table.role} <> 'leader' or ${table.userId} is not null`),
    // An invite only pends on an unclaimed row: claiming it (RF-06) clears the email as it sets the user.
    check("group_members_invite_email_unclaimed", sql`${table.inviteEmail} is null or ${table.userId} is null`),
    check("group_members_external_ref_length", sql`length(${table.externalRef}) <= 200`),
    // `external_ref` is unique within the group scope, so re-importing the same person updates instead of duplicating (RF-51).
    uniqueIndex("group_members_group_external_ref_unique")
      .on(table.groupId, table.externalRef)
      .where(sql`${table.externalRef} is not null`),
    // One group per user: a live claim on any group blocks a second, across the whole table.
    uniqueIndex("group_members_user_unique")
      .on(table.userId)
      .where(sql`${table.userId} is not null and ${table.archivedAt} is null`),
    // One pending invite per email per group; case-folded so a re-invite under a different case is caught.
    uniqueIndex("group_members_group_invite_email_unique")
      .on(table.groupId, sql`lower(${table.inviteEmail})`)
      .where(sql`${table.inviteEmail} is not null`),
    index("group_members_group_id_idx").on(table.groupId),
    index("group_members_user_id_idx").on(table.userId),
    // The self-disjunct mirrors the owner exception on accounts and categories:
    // you can always read your own membership, including the leader claim's INSERT ... RETURNING.
    pgPolicy("group_members_select_member", {
      for: "select",
      to: authenticatedRole,
      using: sql`${table.userId} = ${authUid} or (select private.is_group_member(${table.groupId}))`,
    }),
    // RF-59: exactly one member in an unclaimed group, it is you, and you are its leader.
    pgPolicy("group_members_insert_leader_claim", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${table.userId} and ${table.role} = 'leader' and (select private.group_is_unclaimed(${table.groupId}))`,
    }),
    // RF-07 and RF-100: the leader records a person who has no login of their own.
    pgPolicy("group_members_insert_member", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`(select private.is_group_leader(${table.groupId})) and ${table.userId} is null and ${table.role} = 'member'`,
    }),
    // RF-100: the leader renames, archives and restores anyone; everyone else reaches their own
    // live row alone. The grant leaves `name`, `archived_at` and `invite_email` writable, and the
    // last conjunct denies a caller archiving themselves, so an own row can only be renamed:
    // `invite_email` is barred on it by `group_members_invite_email_unclaimed`. The USING skips an
    // archived own row, or the person the leader archived would restore herself.
    pgPolicy("group_members_update_member", {
      for: "update",
      to: authenticatedRole,
      using: sql`(select private.is_group_leader(${table.groupId})) or (${table.userId} = ${authUid} and ${table.archivedAt} is null)`,
      withCheck: sql`((select private.is_group_leader(${table.groupId})) or ${table.userId} = ${authUid}) and (${table.userId} is distinct from ${authUid} or ${table.archivedAt} is null)`,
    }),
    // RF-11 and RF-100: a member with movements is archived elsewhere, and only the leader drops a
    // row — never her own, which `assert_group_keeps_leader` would refuse a moment later anyway.
    pgPolicy("group_members_delete_member", {
      for: "delete",
      to: authenticatedRole,
      using: sql`(select private.is_group_leader(${table.groupId})) and ${table.userId} is distinct from ${authUid}`,
    }),
  ],
);

export type GroupMember = typeof groupMembers.$inferSelect;
export type NewGroupMember = typeof groupMembers.$inferInsert;
