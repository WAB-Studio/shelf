import { z } from "zod";

// Messages are catalogue keys, not sentences: the form translates them, and
// the server re-runs these exact schemas on the same input (RNF-10). The group
// is resolved from the session (RF-55), so it never travels in the payload.
const MEMBER_NAME_MAX = 80;

const memberNameSchema = z
  .string()
  .trim()
  .min(1, { error: "members.errors.nameRequired" })
  .max(MEMBER_NAME_MAX, { error: "members.errors.nameTooLong" });

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

// RF-07: the onboarding invite asks for the address alone, required. It carries
// no cap of its own below the address's: the name is cut from it, not checked.
export const inviteByEmailSchema = z.object({
  email: z
    .string({ error: "members.errors.emailInvalid" })
    .trim()
    .min(1, { error: "members.errors.emailInvalid" })
    .pipe(z.email({ error: "members.errors.emailInvalid" })),
});

/** The provisional name an invited address gets: the address, within the name's cap. */
export function provisionalMemberName(email: string): string {
  return email.slice(0, MEMBER_NAME_MAX);
}

export const updateMemberSchema = z.object({
  memberId: z.uuid({ error: "errors.notFound" }),
  name: memberNameSchema,
  email: inviteEmailSchema,
});

// Accounts name a user or the group, never a member (RF-61), so archiving one
// carries no per-account decision: it only flags the member.
export const archiveMemberSchema = z.object({
  memberId: z.uuid({ error: "errors.notFound" }),
});

export const restoreMemberSchema = z.object({
  memberId: z.uuid({ error: "errors.notFound" }),
});

export const deleteMemberSchema = z.object({
  memberId: z.uuid({ error: "errors.notFound" }),
});

// RF-59: only the member who takes the role travels. The outgoing leader is the
// caller, read from the session, and the swap is one call the engine makes.
export const transferLeadershipSchema = z.object({
  memberId: z.uuid({ error: "errors.notFound" }),
});

