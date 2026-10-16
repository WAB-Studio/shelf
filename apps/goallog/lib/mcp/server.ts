import { createMcpHandler, generateProtectedResourceMetadata } from "mcp-handler";

import { env } from "@/lib/env";
import { cors } from "@/lib/http/cors";
import { registerReadTools } from "@/lib/mcp/tools/read";
import { registerWriteTools } from "@/lib/mcp/tools/write";

import mcp from "../../messages/es/mcp.json";
import pkg from "../../package.json";

export const SITE_URL = env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "");

export const MCP_URL = `${SITE_URL}/mcp`;

export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

export function buildHandler(): (request: Request) => Promise<Response> {
  return createMcpHandler(
    (server) => {
      registerReadTools(server);
      registerWriteTools(server);
    },
    { serverInfo: { name: "pulsar", version: pkg.version }, instructions: mcp.instructions },
  );
}

const CORS = cors("GET");

// RFC 9728 §3: the document both well-known paths answer.
export function resourceMetadataResponse(): Response {
  const metadata = generateProtectedResourceMetadata({
    authServerUrls: [SITE_URL],
    resourceUrl: MCP_URL,
    additionalMetadata: { bearer_methods_supported: ["header"], resource_name: "pulsar" },
  });

  return new Response(JSON.stringify(metadata), {
    headers: { ...CORS, "Cache-Control": "max-age=3600", "Content-Type": "application/json" },
  });
}

export function resourceMetadataOptions(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
