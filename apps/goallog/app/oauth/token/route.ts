import { z } from "zod";

import { cors } from "@/lib/http/cors";
import { clientFromMetadataUrl } from "@/lib/oauth/client-metadata";
import { exchangeCode, refreshToken, type IssuedTokens } from "@/lib/oauth/grants";
import { callerAddress, claimCall, tooMany } from "@/lib/oauth/throttle";

export const runtime = "nodejs";

const CORS = cors("POST");

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Cache-Control": "no-store", Pragma: "no-cache", "Content-Type": "application/json" },
  });
}

const refused = () => reply(400, { error: "invalid_grant" });

const text = z.string().min(1).max(2048);

const codeGrant = z.object({
  grant_type: z.literal("authorization_code"),
  code: text,
  code_verifier: text,
  client_id: text,
  redirect_uri: text,
});

const refreshGrant = z.object({
  grant_type: z.literal("refresh_token"),
  refresh_token: text,
  client_id: text,
});

// A client named by its metadata URL has its stored id; the rest are ids already.
async function storedClientId(clientId: string, caller: Request["headers"]): Promise<string | null> {
  if (z.uuid().safeParse(clientId).success) return clientId;
  if (!clientId.startsWith("https://")) return null;

  return (await clientFromMetadataUrl(clientId, caller))?.id ?? null;
}

function issued(tokens: IssuedTokens): Response {
  return reply(200, {
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
  });
}

// RFC 6749 §4.1.3 and §6. Every refusal is the same `invalid_grant`: the
// body never says which of code, verifier, client or redirect was wrong.
export async function POST(request: Request): Promise<Response> {
  const claim = await claimCall("token", callerAddress(request));
  if (!claim.ok) return tooMany(claim.retryAfter, CORS);

  const form = await request.formData().catch(() => null);
  if (form === null) return reply(400, { error: "invalid_request" });
  const fields = Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === "string"));

  if (fields.grant_type === "authorization_code") {
    const parsed = codeGrant.safeParse(fields);
    if (!parsed.success) return reply(400, { error: "invalid_request" });
    const clientId = await storedClientId(parsed.data.client_id, request.headers);
    if (clientId === null) return refused();
    const tokens = await exchangeCode({
      code: parsed.data.code,
      verifier: parsed.data.code_verifier,
      clientId,
      redirectUri: parsed.data.redirect_uri,
    });

    return tokens ? issued(tokens) : refused();
  }

  if (fields.grant_type === "refresh_token") {
    const parsed = refreshGrant.safeParse(fields);
    if (!parsed.success) return reply(400, { error: "invalid_request" });
    const clientId = await storedClientId(parsed.data.client_id, request.headers);
    if (clientId === null) return refused();
    const tokens = await refreshToken({ refreshToken: parsed.data.refresh_token, clientId });

    return tokens ? issued(tokens) : refused();
  }

  return reply(400, { error: "unsupported_grant_type" });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
