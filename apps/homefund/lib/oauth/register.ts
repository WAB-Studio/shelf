import { cors } from "@/lib/http/cors";
import { registrationSchema } from "@/lib/oauth/clients";

const CORS = cors("POST");

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Cache-Control": "no-store", "Content-Type": "application/json" },
  });
}

// RFC 7591 §3: a public client, so the response carries no secret.
export async function registrationResponse(
  body: unknown,
  register: (input: { name: string; redirectUris: string[] }) => Promise<string>,
): Promise<Response> {
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) return reply(400, { error: "invalid_client_metadata" });

  const { client_name, redirect_uris } = parsed.data;
  const clientId = await register({ name: client_name, redirectUris: redirect_uris });

  return reply(201, {
    client_id: clientId,
    client_name,
    redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  });
}

export function registrationPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
