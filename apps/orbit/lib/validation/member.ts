import { z } from "zod";

// Messages are catalogue keys, not sentences: the form translates them, and
// the server re-runs these exact schemas on the same input (RNF-10). The group
// is resolved from the session (RF-55), so it never travels in the payload.
const memberNameSchema = z
  .string()
  .trim()
  .min(1, { error: "members.errors.nameRequired" })
  .max(80, { error: "members.errors.nameTooLong" });

// RF-06: an optional invite email. Trimmed, and an empty field reads as absent,
// so a blank input never fails the email check — only a non-empty malformed one.
const inviteEmailSchema = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined))
  .pipe(z.email({ error: "members.errors.emailInvalid" }).optional());

export const createMemberSchema = z.object({
  name: memberNameSchema,
  email: inviteEmailSchema,
});

export type CreateMemberInput = z.infer<typeof createMemberSchema>;

export const updateMemberSchema = z.object({
  memberId: z.uuid({ error: "errors.notFound" }),
  name: memberNameSchema,
});

export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

// Accounts name a user or the group, never a member (RF-61), so archiving one
// carries no per-account decision: it only flags the member.
export const archiveMemberSchema = z.object({
  memberId: z.uuid({ error: "errors.notFound" }),
});

export type ArchiveMemberInput = z.infer<typeof archiveMemberSchema>;

export const restoreMemberSchema = z.object({
  memberId: z.uuid({ error: "errors.notFound" }),
});

export type RestoreMemberInput = z.infer<typeof restoreMemberSchema>;

export const deleteMemberSchema = z.object({
  memberId: z.uuid({ error: "errors.notFound" }),
});

export type DeleteMemberInput = z.infer<typeof deleteMemberSchema>;

// RF-59: only the member who takes the role travels. The outgoing leader is the
// caller, read from the session, and the swap is one call the engine makes.
export const transferLeadershipSchema = z.object({
  memberId: z.uuid({ error: "errors.notFound" }),
});

export type TransferLeadershipInput = z.infer<typeof transferLeadershipSchema>;

