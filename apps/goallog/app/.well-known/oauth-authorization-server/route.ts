import { env } from "@/lib/env";
import { cors } from "@/lib/http/cors";

export const runtime = "nodejs";

const CORS = cors("GET");

// RFC 8414 §2: `issuer` is the very string 190's resource metadata names.
export function GET(): Response {
  const issuer = env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "");

  return new Response(
    JSON.stringify({
      issuer,
      authorization_endpoint: `${issuer}/oauth/autorizar`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/registro`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
    }),
    { headers: { ...CORS, "Cache-Control": "max-age=3600", "Content-Type": "application/json" } },
  );
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
