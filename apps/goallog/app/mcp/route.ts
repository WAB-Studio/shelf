import { withMcpAuth } from "mcp-handler";

import { buildHandler, MCP_URL, RESOURCE_METADATA_PATH } from "@/lib/mcp/server";
import { resolveBearer } from "@/lib/mcp/tokens";

export const runtime = "nodejs";

// A key is the only way in: no cookie is read here, so a browser session
// alone reaches nothing. `resolveBearer` is one statement and never Auth.
async function verify(_request: Request, bearer?: string) {
  if (!bearer) return undefined;
  const person = await resolveBearer(bearer);
  if (person === null) return undefined;

  return { token: "redacted", clientId: "pulsar-key", scopes: [], extra: { person } };
}

const door = withMcpAuth(buildHandler(), verify, {
  required: true,
  resourceMetadataPath: RESOURCE_METADATA_PATH,
  resourceUrl: new URL(MCP_URL).origin,
});

async function noStore(request: Request): Promise<Response> {
  const response = await door(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export { noStore as GET, noStore as POST, noStore as DELETE };
