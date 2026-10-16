import { cors } from "@/lib/http/cors";
import { registerClient } from "@/lib/oauth/grants";
import { registrationSchema } from "@/lib/oauth/clients";
import { callerAddress, claimCall, tooMany } from "@/lib/oauth/throttle";

export const runtime = "nodejs";

const CORS = cors("POST");

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Cache-Control": "no-store", "Content-Type": "application/json" },
  });
}

// RFC 7591 §3: a public client, so the response carries no secret.
export async function POST(request: Request): Promise<Response> {
  const claim = await claimCall("register", callerAddress(request));
  if (!claim.ok) return tooMany(claim.retryAfter, CORS);

  const body: unknown = await request.json().catch(() => null);
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) return reply(400, { error: "invalid_client_metadata" });

  const { client_name, redirect_uris } = parsed.data;
  const clientId = await registerClient({ name: client_name, redirectUris: redirect_uris });

  return reply(201, {
    client_id: clientId,
    client_name,
    redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
