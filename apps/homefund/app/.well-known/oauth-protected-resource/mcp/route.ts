import { MCP_URL } from "@/lib/mcp/server";

// RFC 9728: where a 401 from /mcp points. HomeFund runs no authorization server: the bearer is a key
// the person mints under «Ajustes · Webhooks», sent in the header (RF-144).
export function GET(): Response {
  return Response.json(
    { resource: MCP_URL, bearer_methods_supported: ["header"], resource_name: "HomeFund" },
    { headers: { "Cache-Control": "max-age=3600" } },
  );
}
