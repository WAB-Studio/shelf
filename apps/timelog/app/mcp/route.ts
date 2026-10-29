import { withMcpAuth } from "mcp-handler";

import { resolveKey } from "@/lib/keys";
import { bearerOf } from "@/lib/key-format";
import { buildHandler } from "@/lib/mcp/server";

export const runtime = "nodejs";

// The `tl_` key is the only way in (RT-07): no cookie is read, so a browser session alone reaches nothing.
async function verify(_request: Request, bearer?: string) {
  if (!bearer || bearerOf(`Bearer ${bearer}`) === null) return undefined;
  const person = await resolveKey(bearer);
  if (person === null) return undefined;

  return { token: "redacted", clientId: "timelog-key", scopes: [], extra: { person } };
}

const door = withMcpAuth(buildHandler(), verify, { required: true });

async function noStore(request: Request): Promise<Response> {
  const response = await door(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export { noStore as GET, noStore as POST, noStore as DELETE };
