import { z } from "zod";

import { cors } from "@/lib/http/cors";

const CORS = cors("POST");

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Cache-Control": "no-store", Pragma: "no-cache", "Content-Type": "application/json" },
  });
}

const text = z.string().min(1).max(2048);

const codeGrant = z.object({
  grant_type: z.literal("authorization_code"),
  code: text,
  code_verifier: text,
  client_id: z.uuid(),
  redirect_uri: text,
});

export type Exchange = (input: {
  code: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
}) => Promise<string | null>;

// RFC 6749 §4.1.3. Every refusal of the code is the same `invalid_grant`: the body never says which of
// code, verifier, client or redirect was wrong.
export async function tokenResponse(form: FormData | null, exchange: Exchange): Promise<Response> {
  if (form === null) return reply(400, { error: "invalid_request" });
  const fields = Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === "string"));
  if (fields.grant_type !== "authorization_code") return reply(400, { error: "unsupported_grant_type" });

  const parsed = codeGrant.safeParse(fields);
  if (!parsed.success) return reply(400, { error: "invalid_request" });
  let accessToken: string | null;
  try {
    accessToken = await exchange({
      code: parsed.data.code,
      verifier: parsed.data.code_verifier,
      clientId: parsed.data.client_id,
      redirectUri: parsed.data.redirect_uri,
    });
  } catch (error) {
    // A database failure answers OAuth JSON with the CORS headers, never the platform's HTML 500.
    console.error("oauth token exchange failed:", error instanceof Error ? error.name : "unknown");
    return reply(500, { error: "server_error" });
  }
  if (accessToken === null) return reply(400, { error: "invalid_grant" });

  return reply(200, { access_token: accessToken, token_type: "Bearer" });
}

export function tokenPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
