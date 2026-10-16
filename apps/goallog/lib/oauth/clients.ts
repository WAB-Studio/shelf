import { z } from "zod";

const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

function redirectUriAcceptable(value: string): boolean {
  if (value.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;

  return url.protocol === "http:" && LOOPBACK.has(url.hostname);
}

// An RFC 7591 §2 body; fields the server does not keep are dropped.
export const registrationSchema = z.object({
  client_name: z.string().min(1).max(80),
  redirect_uris: z.array(z.string().refine(redirectUriAcceptable)).min(1).max(5),
  token_endpoint_auth_method: z.literal("none").optional(),
  // A grant the server does not offer is ignored, never refused: claude.ai's
  // metadata document also lists `jwt-bearer`. Only the code grant is required.
  grant_types: z
    .array(z.string())
    .refine((grants) => grants.includes("authorization_code"))
    .optional(),
});

export function redirectAllowed(client: { redirectUris: readonly string[] }, uri: string): boolean {
  return client.redirectUris.includes(uri);
}
