import { z } from "zod";

export const RECIPIENT_KINDS = ["own_account", "person", "payee"] as const;

// The number as a person types or copies it: «*3203359119», «320 335 9119». Only its digits are kept, so
// the stored identifier matches what a notice shows, whole or as a tail (RF-189).
const identifierSchema = z
  .string({ error: "recipients.errors.identifierInvalid" })
  .transform((value) => value.replace(/\D/g, ""))
  .pipe(z.string().regex(/^\d{4,20}$/, { error: "recipients.errors.identifierInvalid" }));

const optionalUuid = (error: string) =>
  z
    .union([z.uuid({ error }), z.literal("")])
    .nullish()
    .transform((value) => value || null);

// The form and the MCP send the same fields; `id` present updates, absent creates. A reference the kind
// does not use is dropped, not refused: the form hides the field and a stale value must not ride along.
export const saveRecipientSchema = z
  .object({
    id: z.uuid({ error: "errors.notFound" }).nullish(),
    identifier: identifierSchema,
    name: z
      .string({ error: "recipients.errors.nameRequired" })
      .trim()
      .min(1, { error: "recipients.errors.nameRequired" })
      .max(80, { error: "recipients.errors.nameTooLong" }),
    kind: z.enum(RECIPIENT_KINDS, { error: "recipients.errors.kindInvalid" }),
    accountId: optionalUuid("recipients.errors.accountInvalid"),
    categoryId: optionalUuid("recipients.errors.categoryInvalid"),
  })
  .transform((data, ctx) => {
    if (data.kind === "own_account" && data.accountId === null) {
      ctx.addIssue({ code: "custom", message: "recipients.errors.accountRequired", path: ["accountId"] });
      return z.NEVER;
    }
    return {
      ...data,
      id: data.id ?? null,
      accountId: data.kind === "payee" ? null : data.accountId,
      categoryId: data.kind === "payee" ? data.categoryId : null,
    };
  });

export type SaveRecipientFields = z.input<typeof saveRecipientSchema>;
export type SaveRecipientInput = z.output<typeof saveRecipientSchema>;

export const deleteRecipientSchema = z.object({
  id: z.uuid({ error: "errors.notFound" }),
});
