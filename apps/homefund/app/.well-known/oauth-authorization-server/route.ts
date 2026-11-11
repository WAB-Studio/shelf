import { ISSUER } from "@/lib/mcp/server";
import { discoveryPreflight, authorizationServerResponse } from "@/lib/oauth/discovery";
import { requestHost, servedOrigin } from "@/lib/oauth/hosts";

export const runtime = "nodejs";

// The issuer is the host the request came on, when this app serves it: the connector URL may be either.
export function GET(request: Request): Response {
  return authorizationServerResponse(servedOrigin(requestHost(request), ISSUER));
}

export { discoveryPreflight as OPTIONS };
