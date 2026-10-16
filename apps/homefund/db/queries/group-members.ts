import "server-only";

import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { insertRow } from "@/db/insert-row";
import { callerGroupId, callerGroupInfo } from "@/db/queries/groups";
import { groupMembers } from "@/db/schema";
import type { GroupMember } from "@/db/schema";
import type { Transaction } from "@/db/session";
import { requireUser, withUserDb, withUserDbOrTx } from "@/db/session";
import { pgErrorCode } from "@/lib/db-error";

type GroupMemberRole = GroupMember["role"];

export type MemberRow = {
  id: string;
  name: string;
  role: GroupMemberRole;
  userId: string | null;
  inviteEmail: string | null;
  archivedAt: Date | null;
};

// Ordered for a roster, not a ledger: `name` is the only order a user compares by.
export async function listMembers(
  groupId: string,
  options: { archived: boolean },
): Promise<MemberRow[]> {
  return withUserDb(async (tx) =>
    tx
      .select({
        id: groupMembers.id,
        name: groupMembers.name,
        role: groupMembers.role,
        userId: groupMembers.userId,
        inviteEmail: groupMembers.inviteEmail,
        archivedAt: groupMembers.archivedAt,
      })
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, groupId),
          options.archived
            ? isNotNull(groupMembers.archivedAt)
            : isNull(groupMembers.archivedAt),
        ),
      )
      .orderBy(asc(groupMembers.name)),
  );
}

/**
 * The caller's own roster, with no group id to pass: the membership rides as a
 * subselect. `archived: "all"`
 * reads both rosters at once — a movement or an audit row outlives the member who
 * caused it, so naming one needs the archived names too.
 */
export async function listCallerMembers(
  userId: string,
  options: { archived: boolean | "all" },
  outerTx?: Transaction,
): Promise<MemberRow[]> {
  const archivedFilter =
    options.archived === "all"
      ? undefined
      : options.archived
        ? isNotNull(groupMembers.archivedAt)
        : isNull(groupMembers.archivedAt);

  return withUserDbOrTx(outerTx, async (tx) =>
    tx
      .select({
        id: groupMembers.id,
        name: groupMembers.name,
        role: groupMembers.role,
        userId: groupMembers.userId,
        inviteEmail: groupMembers.inviteEmail,
        archivedAt: groupMembers.archivedAt,
      })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, callerGroupId(userId)), archivedFilter))
      .orderBy(asc(groupMembers.name)),
  );
}

/**
 * The members screen in one transaction: the roster and the caller's role read
 * together, the group resolved in SQL by `callerGroupId` (RF-100). `null` when the
 * caller has no group.
 */
export async function getMembersScreenData({
  archived,
}: {
  archived: boolean;
}): Promise<{ members: MemberRow[]; isLeader: boolean } | null> {
  const user = await requireUser();

  return withUserDb(async (tx) => {
    const [group, members] = await Promise.all([
      callerGroupInfo(tx, user.id),
      listCallerMembers(user.id, { archived }, tx),
    ]);
    if (!group) return null;

    return { members, isLeader: group.role === "leader" };
  });
}

// `user_id` stays null and `role` stays at its default — the only shape
// `group_members_insert_member` accepts (RF-07: a member need not have a login),
// and it accepts it from the leader alone (RF-100), who is the only caller whose
// insert lands rather than raising 42501. An `inviteEmail` pends on the row until
// the invited person signs in (RF-06).
export async function createMember({
  groupId,
  name,
  inviteEmail,
}: {
  groupId: string;
  name: string;
  inviteEmail?: string;
}): Promise<{ memberId: string }> {
  return withUserDb(async (tx) => {
    const [row] = await insertRow(
      tx,
      groupMembers,
      { groupId, name, inviteEmail: inviteEmail ?? null },
      { returning: { id: groupMembers.id } },
    );

    return { memberId: row.id };
  });
}

// RF-06: the invited person claims their pending row on first sign-in. No row id
// and no user id cross the boundary — `private.claim_group_invite` reads
// auth.uid() and auth.email() from the caller's own verified session and picks
// the one unclaimed row that matches, so a claim cannot be aimed at another row.
// `email` only spares the round trip for a session that carries no address; the
// claim keys on what the database reads, not on what is passed here.
export async function claimInviteForUser({
  email,
}: {
  email: string;
}): Promise<"claimed" | "none" | "already-in-group"> {
  if (!email) return "none";

  // The catch sits OUTSIDE the transaction: postgres.js keeps the first query
  // error of a transaction and rethrows it at commit, so catching inside the
  // callback would let the refusal past this branch and out to the caller.
  try {
    const rows = await withUserDb((tx) =>
      tx.execute<{ id: string | null }>(sql`select private.claim_group_invite() as id`),
    );

    return rows[0]?.id ? "claimed" : "none";
  } catch (error) {
    // `group_members_user_unique` rejects a caller who already holds a live
    // membership: they cannot be claimed into a second group (RF-55).
    if (pgErrorCode(error) === "23505") return "already-in-group";
    throw error;
  }
}

// RF-59: the role moves in one statement. No group id and no source member cross
// the boundary — `private.transfer_group_leadership` reads auth.uid() and demotes
// the caller as it promotes the target, so the group is never left with two
// leaders or none. A refusal is a 23514 the action layer reads; nothing is caught
// here, and a catch would have to sit outside `withUserDb` anyway.
export async function transferLeadership({
  memberId,
}: {
  memberId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx.execute<{ ok: boolean }>(
      sql`select private.transfer_group_leadership(${memberId}) as ok`,
    );

    return rows[0]?.ok === true;
  });
}

// RF-100: the leader renames anyone, everyone else their own row — the policy
// filters the rest out, so a refused rename returns no row rather than raising.
export async function updateMember({
  groupId,
  memberId,
  name,
}: {
  groupId: string;
  memberId: string;
  name: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(groupMembers)
      .set({ name })
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.id, memberId)))
      .returning({ id: groupMembers.id });

    return rows.length > 0;
  });
}

// Accounts name a user or the group, never a member, so archiving one only sets
// its own flag. The leader alone archives (RF-100), and the policy raises 42501
// on one row only: the caller's own.
export async function archiveMember({
  groupId,
  memberId,
}: {
  groupId: string;
  memberId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(groupMembers)
      .set({ archivedAt: sql`now()` })
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.id, memberId)))
      .returning({ id: groupMembers.id });

    return rows.length > 0;
  });
}

// RF-100: restoring is the leader's, and the archived row is outside the update
// policy's USING, so the person she archived cannot bring themselves back.
export async function restoreMember({
  groupId,
  memberId,
}: {
  groupId: string;
  memberId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(groupMembers)
      .set({ archivedAt: null })
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.id, memberId)))
      .returning({ id: groupMembers.id });

    return rows.length > 0;
  });
}

// The delete policy takes the leader alone (RF-100) and refuses even her own row (RF-11).
export async function deleteMember({
  groupId,
  memberId,
}: {
  groupId: string;
  memberId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.id, memberId)))
      .returning({ id: groupMembers.id });

    return rows.length > 0;
  });
}
