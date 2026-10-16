"use server";

import { refresh } from "next/cache";

import {
  archiveMember,
  createMember,
  deleteMember,
  restoreMember,
  transferLeadership,
  updateMember,
} from "@/db/queries/group-members";
import { getUserGroup } from "@/db/queries/groups";
import { pgErrorCode } from "@/lib/db-error";
import { env } from "@/lib/env";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  archiveMemberSchema,
  createMemberSchema,
  deleteMemberSchema,
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

// RF-100 gave every member write to the leader alone, and the policies filter rather
// than raise: an UPDATE or a DELETE the caller does not lead returns no row, while an
// INSERT and the own-row WITH CHECK raise 42501. Both read as the same refusal.
function notLeader(): never {
  throw new ActionError("errors.notLeader");
}

// RF-06: the same passwordless path as sign-in, so the invited person accepts by
// clicking the link. `shouldCreateUser` provisions the address if it has none.
// Returns false on failure so the create stays non-fatal — the member still lands.
async function sendInviteEmail(email: string): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/confirm`,
    },
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
    const groupId = await requireGroupId();
    let memberId: string;
    try {
      ({ memberId } = await createMember({ groupId, name, inviteEmail: email }));
    } catch (error) {
      if (pgErrorCode(error) === "42501") notLeader();
      throw error;
    }

    // A failed send leaves the member pending rather than aborting the create;
    // the caller surfaces it as a notice, not an error.
    const inviteEmailFailed = email ? !(await sendInviteEmail(email)) : false;

    refresh();
    return { memberId, inviteEmailFailed };
  });

export const updateMemberAction = authActionClient
  .inputSchema(updateMemberSchema)
  .action(async ({ parsedInput: { memberId, name } }) => {
    const groupId = await requireGroupId();
    const updated = await updateMember({ groupId, memberId, name });
    if (!updated) notLeader();

    refresh();
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
    const restored = await restoreMember({ groupId, memberId });
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
