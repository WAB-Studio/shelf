import { cors } from "@/lib/http/cors";

const CORS = cors("GET");

const headers = { ...CORS, "Cache-Control": "max-age=3600", "Content-Type": "application/json" };

// RFC 8414 §2: `issuer` is the very string the resource metadata names as its authorization server.
export function authorizationServerResponse(issuer: string): Response {
  return new Response(
    JSON.stringify({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    }),
    { headers },
  );
}

// RFC 9728 §3: where the 401 from /mcp points, and the server that signs people in for it.
export function resourceMetadataResponse(issuer: string): Response {
  return new Response(
    JSON.stringify({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      resource_name: "HomeFund",
    }),
    { headers },
  );
}

export function discoveryPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
