import { z } from "zod";

export const createTokenSchema = z.object({
  name: z
    .string({ error: "connections.errors.nameEmpty" })
    .trim()
    .min(1, { error: "connections.errors.nameEmpty" })
    .max(60, { error: "connections.errors.nameTooLong" }),
});

export type CreateTokenInput = z.infer<typeof createTokenSchema>;

export const revokeTokenSchema = z.object({
  tokenId: z.uuid({ error: "connections.errors.notFound" }),
});

export type RevokeTokenInput = z.infer<typeof revokeTokenSchema>;
