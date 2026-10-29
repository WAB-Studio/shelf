import { resourceMetadataOptions, resourceMetadataResponse } from "@/lib/mcp/server";

export const runtime = "nodejs";

export function GET(): Response {
  return resourceMetadataResponse();
}

export function OPTIONS(): Response {
  return resourceMetadataOptions();
}
