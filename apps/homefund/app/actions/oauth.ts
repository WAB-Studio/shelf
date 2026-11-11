"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { env } from "@/lib/env";
import { ISSUER } from "@/lib/mcp/server";
import { servedOrigin, servedOrigins } from "@/lib/oauth/hosts";
import { ActionError } from "@/lib/errors";
import { findClient, issueCode } from "@/lib/oauth/grants";
import { redirectAllowed } from "@/lib/oauth/clients";
import { authActionClient } from "@/lib/safe-action";
import { authorizationRequestSchema, redirectBack } from "@/lib/validation/oauth";

const schema = authorizationRequestSchema(servedOrigins(env.NEXT_PUBLIC_SITE_URL));

// The `iss` the client checks is the issuer it discovered, the host it reached us on.
async function issuerOfRequest(): Promise<string> {
  return servedOrigin((await headers()).get("host"), ISSUER);
}

// A client this server never registered, or a redirect it did not register, is refused before any redirect:
// the person is never sent to an address the request alone named.
async function registeredClient(request: z.infer<typeof schema>) {
  const client = await findClient(request.client_id);
  if (!client) throw new ActionError("oauth.errors.clientUnknown");
  if (!redirectAllowed(client, request.redirect_uri)) throw new ActionError("oauth.errors.redirectMismatch");

  return client;
}

/** Issues a code for the signed-in person and returns where to send them. Not an MCP tool. */
export const approveAuthorizationAction = authActionClient
  .inputSchema(schema)
  .action(async ({ parsedInput, ctx }) => {
    const client = await registeredClient(parsedInput);
    const code = await issueCode({
      ownerUserId: ctx.user.id,
      clientId: client.id,
      challenge: parsedInput.code_challenge,
      redirectUri: parsedInput.redirect_uri,
    });

    return { redirectTo: redirectBack(parsedInput, { code, iss: await issuerOfRequest() }) };
  });

/** Sends the person back to a registered client with `access_denied`; no code is written. */
export const denyAuthorizationAction = authActionClient.inputSchema(schema).action(async ({ parsedInput }) => {
  await registeredClient(parsedInput);

  return { redirectTo: redirectBack(parsedInput, { error: "access_denied", iss: await issuerOfRequest() }) };
});
