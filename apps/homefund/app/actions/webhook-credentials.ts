"use server";

import { refresh } from "next/cache";

import {
  getWebhookCredentialOptions,
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

// Nothing in the table ties a default category to its default account's scope, so
// a pair the form would never offer is refused here before it is stored (RF-140).
// A row the options do not list is left to the write, which maps it as before.
async function assertDefaultsShareScope(
  defaultAccountId: string | null | undefined,
  defaultCategoryId: string | null | undefined,
): Promise<void> {
  if (!defaultAccountId || !defaultCategoryId) return;
  const options = await getWebhookCredentialOptions();
  const account = options.accounts.find((one) => one.id === defaultAccountId);
  const category = options.categories.find((one) => one.id === defaultCategoryId);
  if (account && category && account.scope !== category.scope) {
    throw new ActionError("webhooks.errors.scopeViolation");
  }
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
      await assertDefaultsShareScope(defaultAccountId, defaultCategoryId);

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
