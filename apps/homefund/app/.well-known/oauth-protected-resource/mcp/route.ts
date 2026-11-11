import { ISSUER } from "@/lib/mcp/server";
import { discoveryPreflight, resourceMetadataResponse } from "@/lib/oauth/discovery";
import { requestHost, servedOrigin } from "@/lib/oauth/hosts";

export const runtime = "nodejs";

// RFC 9728: where a 401 from /mcp points. Claude on claude.ai signs in with HomeFund's own authorization
// server (RF-168); a key minted under «Ajustes · Webhooks» in the header still opens the door (RF-144).
export function GET(request: Request): Response {
  return resourceMetadataResponse(servedOrigin(requestHost(request), ISSUER));
}

export { discoveryPreflight as OPTIONS };
