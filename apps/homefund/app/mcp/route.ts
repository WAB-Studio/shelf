import { withMcpAuth } from "mcp-handler";

import { resolveWebhookCredential, type ResolvedWebhookCredential } from "@/db/queries/webhook-credentials";
import { buildHandler, MCP_URL, RESOURCE_METADATA_PATH } from "@/lib/mcp/server";

export const runtime = "nodejs";

const BEARER = /^Bearer\s+(.+)$/i;

// The credential each request resolved, read back by `verify`: resolving twice would count twice
// against the key's per-minute window.
const resolved = new WeakMap<Request, ResolvedWebhookCredential>();

// Only a key minted for Claude opens this door (RF-144): a webhook key never does, and no cookie is
// read. An unknown and a revoked key answer the same 401, so a key's state never leaks.
async function verify(request: Request) {
  const credential = resolved.get(request);
  if (!credential) return undefined;
  return { token: "redacted", clientId: credential.credentialId, scopes: [], extra: { ownerUserId: credential.ownerUserId } };
}

const door = withMcpAuth(buildHandler(), verify, {
  required: true,
  resourceMetadataPath: RESOURCE_METADATA_PATH,
  resourceUrl: new URL(MCP_URL).origin,
});

async function handle(request: Request): Promise<Response> {
  const bearer = request.headers.get("authorization")?.match(BEARER)?.[1]?.trim();
  const credential = bearer ? await resolveWebhookCredential(bearer, "mcp") : null;
  // A live key over its window is not a bad key: 429 tells the client to wait, not to sign in again.
  if (credential?.throttled) {
    return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "60" } });
  }
  if (credential) resolved.set(request, credential);
  const response = await door(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export { handle as GET, handle as POST, handle as DELETE };
