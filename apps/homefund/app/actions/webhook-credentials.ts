"use server";

import { refresh } from "next/cache";

import {
  issueWebhookCredential,
  revokeWebhookCredential,
} from "@/db/queries/webhook-credentials";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import {
  issueWebhookCredentialSchema,
  revokeWebhookCredentialSchema,
} from "@/lib/validation/webhook";

// A default account or category that does not exist trips a foreign key (23503);
// one the owner cannot read reads the same as a denied write (42501). Either way
// the caller learns only that the referenced row was not there.
function mapCredentialError(error: unknown): never {
  const code = pgErrorCode(error);
  if (code === "23503") throw new ActionError("errors.notFound");
  if (code === "42501") throw new ActionError("errors.notFound");
  throw error;
}

/**
 * Mints a webhook credential and returns its raw bearer once (RF-86). The owner
 * is trigger-stamped from the session, so the payload names no scope; only the
 * hash is stored, and `token` is the single moment the plaintext exists.
 */
export const issueWebhookCredentialAction = authActionClient
  .inputSchema(issueWebhookCredentialSchema)
  .action(
    async ({
      parsedInput: { name, defaultAccountId, defaultCategoryId, rateLimitPerMin },
    }) => {
      let credential: { id: string; token: string };
      try {
        credential = await issueWebhookCredential({
          name,
          defaultAccountId: defaultAccountId ?? null,
          defaultCategoryId: defaultCategoryId ?? null,
          rateLimitPerMin,
        });
      } catch (error) {
        mapCredentialError(error);
      }

      refresh();
      return credential;
    },
  );

// A false row count is a credential the owner policy did not admit — denied or
// already gone — and reads the same as one that was never there (RF-86).
export const revokeWebhookCredentialAction = authActionClient
  .inputSchema(revokeWebhookCredentialSchema)
  .action(async ({ parsedInput: { id } }) => {
    const revoked = await revokeWebhookCredential({ id });
    if (!revoked) throw new ActionError("errors.notFound");

    refresh();
  });
