import { z } from "zod";

import { occurredAtSchema, pesoAmountSchema } from "@/lib/validation/transaction";

// The inbound body arrives in snake_case to match the ingest payload the C5
// query declared, so the schema parses those keys unchanged and its output
// feeds `ingestWebhookMovement` without a rename.
const amountSchema = pesoAmountSchema({
  required: "webhooks.errors.amountRequired",
  invalid: "webhooks.errors.amountInvalid",
  tooLarge: "webhooks.errors.amountTooLarge",
});

// `external_ref` is optional: a caller that sends none gets the idempotency key
// the per-scope unique index needs derived from the message text, and one that
// sends its own overrides that. Every other field is a caller override the
// interpreter's proposal yields to.
export const webhookPayloadSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, { error: "webhooks.errors.textRequired" })
    .max(320, { error: "webhooks.errors.textTooLong" }),
  external_ref: z
    .string()
    .trim()
    .min(1, { error: "webhooks.errors.externalRefRequired" })
    .max(200, { error: "webhooks.errors.externalRefTooLong" })
    .optional(),
  amount: amountSchema.optional(),
  occurred_at: occurredAtSchema.optional(),
  account_id: z.uuid({ error: "webhooks.errors.accountInvalid" }).optional(),
  direction: z
    .enum(["expense", "income"], { error: "webhooks.errors.directionInvalid" })
    .optional(),
});

// The keys and value types mirror `WebhookIngestPayload`, so the parsed body
// feeds `ingestWebhookMovement` unchanged; the route (C7) exercises that pass.
export type WebhookPayloadInput = z.infer<typeof webhookPayloadSchema>;

// What a key is for, picked when it is made (RF-198); never read off its name.
export const credentialKindSchema = z.enum(["android", "iphone", "bank_emails", "other"], {
  error: "webhooks.errors.kindInvalid",
});
export type CredentialKind = z.infer<typeof credentialKindSchema>;

// The badge a key wears: a Claude key (`mcp`) is Claude whatever its kind column holds.
export type CredentialBadge = CredentialKind | "claude";

export function credentialBadge(purpose: "ingest" | "mcp", kind: CredentialKind): CredentialBadge {
  return purpose === "mcp" ? "claude" : kind;
}

// A credential names no scope: the owner is trigger-stamped, so the payload
// carries only its name, its optional defaults and an optional throttle.
export const issueWebhookCredentialSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: "webhooks.errors.nameRequired" })
    .max(80, { error: "webhooks.errors.nameTooLong" }),
  kind: credentialKindSchema.default("other"),
  defaultAccountId: z.uuid({ error: "webhooks.errors.accountInvalid" }).nullish(),
  defaultCategoryId: z.uuid({ error: "webhooks.errors.categoryInvalid" }).nullish(),
  rateLimitPerMin: z
    .number({ error: "webhooks.errors.rateLimitInvalid" })
    .int({ error: "webhooks.errors.rateLimitInvalid" })
    .positive({ error: "webhooks.errors.rateLimitInvalid" })
    .max(1000, { error: "webhooks.errors.rateLimitInvalid" })
    .default(60),
});

export const revokeWebhookCredentialSchema = z.object({
  id: z.uuid({ error: "webhooks.errors.credentialInvalid" }),
});

