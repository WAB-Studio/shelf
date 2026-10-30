import { withMcpAuth } from "mcp-handler";

import { resolveWebhookCredential } from "@/db/queries/webhook-credentials";
import { buildHandler } from "@/lib/mcp/server";

export const runtime = "nodejs";

// The key a person mints under «Ajustes · Conexiones» is the only way in (RF-144): no cookie is read
// here. A revoked, unknown or throttled key all answer the same 401, so a key's state never leaks.
async function verify(_request: Request, bearer?: string) {
  if (!bearer) return undefined;
  const credential = await resolveWebhookCredential(bearer);
  if (credential === null || credential.throttled) return undefined;
  return {
    token: "redacted",
    clientId: credential.credentialId,
    scopes: [],
    extra: { ownerUserId: credential.ownerUserId },
  };
}

const door = withMcpAuth(buildHandler(), verify, { required: true });

async function noStore(request: Request): Promise<Response> {
  const response = await door(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export { noStore as GET, noStore as POST, noStore as DELETE };
