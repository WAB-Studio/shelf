import "server-only";

import {
  archiveMember,
  createMember,
  restoreMember,
  updateMember,
} from "@/db/queries/group-members";
import { getUserGroup, updateGroupSettings } from "@/db/queries/groups";
import { pgConstraintName, pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import type { Locale } from "@/lib/locales";
import type { UpdateGroupInput } from "@/lib/validation/group";

// The writes behind the members and fund-settings forms' actions and behind `/mcp`: each throws an
// `ActionError` carrying a catalogue key, so both doors refuse in the same words. Nothing here sends mail.

// Members live inside a group; a caller who runs personal-only has none (RF-55).
export async function requireGroupId(): Promise<string> {
  const group = await getUserGroup();
  if (!group) throw new ActionError("errors.notFound");
  return group.id;
}

// RF-100 gave every member write to the leader alone, and the policies filter rather
// than raise: an UPDATE or a DELETE the caller does not lead returns no row, while an
// INSERT and the own-row WITH CHECK raise 42501. Both read as the same refusal.
export function notLeader(): never {
  throw new ActionError("errors.notLeader");
}

/** Adds a member to the caller's fund; with `inviteEmail` it holds the address, which this never mails. */
export async function addMember(input: {
  groupId: string;
  name: string;
  inviteEmail?: string;
}): Promise<{ memberId: string }> {
  try {
    return await createMember(input);
  } catch (error) {
    const code = pgErrorCode(error);
    if (code === "42501") notLeader();
    if (code === "23505") throw new ActionError("members.errors.emailTaken");
    throw error;
  }
}

/** Renames a member and leaves the address as it is. */
export async function renameMember(input: {
  groupId: string;
  memberId: string;
  name: string;
}): Promise<void> {
  const renamed = await updateMember(input);
  if (!renamed) notLeader();
}

// RF-61: archiving a member leaves their accounts untouched — the flag is the
// only write. The caller's own row is the one an archive raises on: it passes the
// policy's USING and trips its WITH CHECK.
export async function archiveMemberChecked(input: {
  groupId: string;
  memberId: string;
}): Promise<void> {
  let archived: boolean;
  try {
    archived = await archiveMember(input);
  } catch (error) {
    if (pgErrorCode(error) === "42501") throw new ActionError("errors.selfArchive");
    throw error;
  }
  if (!archived) notLeader();
}

export async function restoreMemberChecked(input: {
  groupId: string;
  memberId: string;
}): Promise<void> {
  let restored: boolean;
  try {
    restored = await restoreMember(input);
  } catch (error) {
    // RF-149: a newer invitation holds the address this one would take back.
    if (
      pgErrorCode(error) === "23505" &&
      pgConstraintName(error) === "group_members_group_invite_email_unique"
    ) {
      throw new ActionError("members.errors.emailTaken");
    }
    throw error;
  }
  if (!restored) notLeader();
}

/**
 * Renames the caller's group, sets where its cash sits and what it reports in
 * (RF-56, RF-57, RF-121). The group comes from the session, never from the
 * input (RF-55). `locale` names the cash account a switch to 'shared' may
 * create. The leader alone gets a row back, so `false` reads as the refusal it is.
 */
export async function updateFund(
  { name, cashMode, currency }: UpdateGroupInput,
  locale: Locale,
): Promise<void> {
  const group = await getUserGroup();
  if (!group) throw new ActionError("errors.notFound");

  const updated = await updateGroupSettings({ groupId: group.id, name, cashMode, currency, locale });
  if (!updated) notLeader();
}
