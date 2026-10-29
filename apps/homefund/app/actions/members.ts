"use server";

import { refresh } from "next/cache";

import {
  acceptInvitation,
  archiveMember,
  createMember,
  declineInvitation,
  deleteMember,
  inviteEmailIsMember,
  leaveFund,
  restoreMember,
  transferLeadership,
  updateMember,
  type UpdateMemberStatus,
} from "@/db/queries/group-members";
import { getUserGroup } from "@/db/queries/groups";
import { deliverabilityExempt, isDomainDeliverable } from "@/lib/auth/deliverability";
import { pgConstraintName, pgErrorCode } from "@/lib/db-error";
import { env } from "@/lib/env";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  archiveMemberSchema,
  createMemberSchema,
  deleteMemberSchema,
  inviteByEmailSchema,
  invitationActSchema,
  leaveFundSchema,
  provisionalMemberName,
  restoreMemberSchema,
  transferLeadershipSchema,
  updateMemberSchema,
} from "@/lib/validation/member";

// Members live inside a group; a caller who runs personal-only has none (RF-55).
async function requireGroupId(): Promise<string> {
  const group = await getUserGroup();
  if (!group) throw new ActionError("errors.notFound");
  return group.id;
}

// RF-150 / RF-151: the group, the membership and the domain are asked together, and a
// refusal lands before any row is written or any mail asked. The caller who does not
// lead the fund learns false from the membership read and meets the leader guard later.
async function requireInvitableGroupId(email: string | undefined): Promise<string> {
  if (!email) return requireGroupId();

  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  const [groupId, isMember, deliverable] = await Promise.all([
    requireGroupId(),
    inviteEmailIsMember(email),
    Promise.resolve(
      deliverabilityExempt(domain, env.NEXT_PUBLIC_SUPABASE_URL) || isDomainDeliverable(domain),
    ),
  ]);
  if (isMember) throw new ActionError("members.errors.alreadyMember");
  if (!deliverable) throw new ActionError("errors.domainUndeliverable");
  return groupId;
}

// RF-100 gave every member write to the leader alone, and the policies filter rather
// than raise: an UPDATE or a DELETE the caller does not lead returns no row, while an
// INSERT and the own-row WITH CHECK raise 42501. Both read as the same refusal.
function notLeader(): never {
  throw new ActionError("errors.notLeader");
}

// RF-06 / RF-148: Auth's own invitation, sent from the server with the secret key,
// so nothing runs in the inviter's browser and the mail is the invite template.
// The 0058 trigger has already put the address on the list. Returns false on any
// failure, an address Auth already holds included, so the member still lands.
async function sendInviteEmail(email: string): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    console.error("invite email not sent: SUPABASE_SECRET_KEY is not set");
    return false;
  }
  const { error } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${env.NEXT_PUBLIC_SITE_URL}/login`,
  });
  if (error) {
    console.error("invite email request failed", error);
    return false;
  }
  return true;
}

export const createMemberAction = authActionClient
  .inputSchema(createMemberSchema)
  .action(async ({ parsedInput: { name, email } }) => {
    const groupId = await requireInvitableGroupId(email);
    let memberId: string;
    try {
      ({ memberId } = await createMember({ groupId, name, inviteEmail: email }));
    } catch (error) {
      const code = pgErrorCode(error);
      if (code === "42501") notLeader();
      if (code === "23505") throw new ActionError("members.errors.emailTaken");
      throw error;
    }

    // A failed send leaves the member pending rather than aborting the create;
    // the caller surfaces it as a notice, not an error.
    const inviteEmailFailed = email ? !(await sendInviteEmail(email)) : false;

    refresh();
    return { memberId, inviteEmailFailed };
  });

// RF-07: the onboarding invite. The address is required and names the member
// provisionally; the person renames it later. Refuses and sends as `createMemberAction`.
export const inviteMemberByEmailAction = authActionClient
  .inputSchema(inviteByEmailSchema)
  .action(async ({ parsedInput: { email } }) => {
    const groupId = await requireInvitableGroupId(email);
    let memberId: string;
    try {
      ({ memberId } = await createMember({
        groupId,
        name: provisionalMemberName(email),
        inviteEmail: email,
      }));
    } catch (error) {
      const code = pgErrorCode(error);
      if (code === "42501") notLeader();
      if (code === "23505") throw new ActionError("members.errors.emailTaken");
      throw error;
    }

    const inviteEmailFailed = !(await sendInviteEmail(email));

    refresh();
    return { memberId, inviteEmailFailed };
  });

// RF-153: an address given to a placeholder member invites as the create does,
// with the same guards, and a refusal writes nothing. Without one it renames.
export const updateMemberAction = authActionClient
  .inputSchema(updateMemberSchema)
  .action(async ({ parsedInput: { memberId, name, email } }) => {
    const groupId = await requireInvitableGroupId(email);

    if (email === undefined) {
      const renamed = await updateMember({ groupId, memberId, name });
      if (!renamed) notLeader();

      refresh();
      return { inviteEmailFailed: false };
    }

    let status: UpdateMemberStatus;
    try {
      status = await updateMember({ groupId, memberId, name, inviteEmail: email });
    } catch (error) {
      if (pgErrorCode(error) === "23505") throw new ActionError("members.errors.emailTaken");
      throw error;
    }
    if (status === "notLeader") notLeader();
    if (status === "gone") throw new ActionError("errors.notFound");
    if (status === "hasUser") throw new ActionError("members.errors.alreadyMember");
    if (status === "hasInvite") throw new ActionError("members.errors.emailTaken");

    const inviteEmailFailed = !(await sendInviteEmail(email));

    refresh();
    return { inviteEmailFailed };
  });

// RF-61: archiving a member leaves their accounts untouched — the flag is the
// only write. The caller's own row is the one an archive raises on: it passes the
// policy's USING and trips its WITH CHECK.
export const archiveMemberAction = authActionClient
  .inputSchema(archiveMemberSchema)
  .action(async ({ parsedInput: { memberId } }) => {
    const groupId = await requireGroupId();
    let archived: boolean;
    try {
      archived = await archiveMember({ groupId, memberId });
    } catch (error) {
      if (pgErrorCode(error) === "42501") throw new ActionError("errors.selfArchive");
      throw error;
    }
    if (!archived) notLeader();

    refresh();
  });

export const restoreMemberAction = authActionClient
  .inputSchema(restoreMemberSchema)
  .action(async ({ parsedInput: { memberId } }) => {
    const groupId = await requireGroupId();
    let restored: boolean;
    try {
      restored = await restoreMember({ groupId, memberId });
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

    refresh();
  });

// RF-11: the engine refuses to drop a person whose user created a movement, owns
// one or owns an account. The refusal is a 23514 the trigger raises, not a row
// count, so it needs its own catch — the zero-row path still means the caller
// does not lead this group.
export const deleteMemberAction = authActionClient
  .inputSchema(deleteMemberSchema)
  .action(async ({ parsedInput: { memberId } }) => {
    const groupId = await requireGroupId();
    let deleted: boolean;
    try {
      deleted = await deleteMember({ groupId, memberId });
    } catch (error) {
      if (pgErrorCode(error) === "23514") throw new ActionError("errors.memberHasHistory");
      throw error;
    }
    if (!deleted) notLeader();

    refresh();
  });

// RF-59: the role moves and the caller steps down in the same call. No group id
// travels — `transferLeadership` reads the caller's own membership — and the
// group is resolved here only to turn a personal-only caller away first. Every
// refusal the engine raises is a 23514, and the caller not being the leader is
// the only one this action's own screen can reach.
export const transferLeadershipAction = authActionClient
  .inputSchema(transferLeadershipSchema)
  .action(async ({ parsedInput: { memberId } }) => {
    await requireGroupId();
    try {
      await transferLeadership({ memberId });
    } catch (error) {
      if (pgErrorCode(error) === "23514") notLeader();
      throw error;
    }

    refresh();
  });

// RF-154: joining is the invited person's tap. A row that is withdrawn, declined, taken
// or addressed to someone else all read "gone": the screen learns no more than that.
export const acceptInvitationAction = authActionClient
  .inputSchema(invitationActSchema)
  .action(async ({ parsedInput: { memberId } }) => {
    const result = await acceptInvitation({ memberId });
    if (result === "gone") throw new ActionError("errors.invitationGone");
    if (result === "otherFund") throw new ActionError("errors.alreadyInFund");

    refresh();
  });

export const declineInvitationAction = authActionClient
  .inputSchema(invitationActSchema)
  .action(async ({ parsedInput: { memberId } }) => {
    const result = await declineInvitation({ memberId });
    if (result === "gone") throw new ActionError("errors.invitationGone");

    refresh();
  });

// RF-154: a member leaves; a leader stays, alone or not, until she hands the fund over.
export const leaveFundAction = authActionClient
  .inputSchema(leaveFundSchema)
  .action(async () => {
    const result = await leaveFund();
    if (result === "leaderStays") throw new ActionError("errors.leaderStays");
    if (result === "notInFund") throw new ActionError("errors.notFound");

    refresh();
  });
