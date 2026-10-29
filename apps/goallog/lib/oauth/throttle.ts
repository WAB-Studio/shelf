import { isIPv6 } from "node:net";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { ipv6Bytes } from "@/lib/net/ipv6";
import { fingerprint } from "@/lib/mcp/tokens";

export const LIMITS = {
  register: { cap: 10, windowSeconds: 3600 },
  token: { cap: 30, windowSeconds: 300 },
} as const;

export type Bucket = keyof typeof LIMITS;

/**
 * The caller's address: on Vercel `x-vercel-forwarded-for`, which the platform
 * writes and a client cannot set; elsewhere the first value of `x-forwarded-for`. IPv6 is reduced to its /64, the
 * block one host holds. A missing or unparsable header is one shared `"unknown"`.
 */
export function callerAddress(request: { headers: { get(name: string): string | null } }): string {
  const header = process.env.VERCEL ? "x-vercel-forwarded-for" : "x-forwarded-for";
  const first = request.headers.get(header)?.split(",")[0].trim() ?? "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(first) && first.split(".").every((part) => Number(part) <= 255)) return first;
  if (isIPv6(first.split("%")[0])) {
    const bytes = ipv6Bytes(first);
    if (bytes) {
      const groups = Array.from({ length: 4 }, (_, at) => (bytes[at * 2] << 8) | bytes[at * 2 + 1]);
      return `${groups.map((group) => group.toString(16)).join(":")}::/64`;
    }
  }

  return "unknown";
}

/**
 * Counts one call against the address's window in one statement, so two calls
 * cannot both slip under the cap. Only a fingerprint of the address is stored.
 */
export async function claimCall(
  bucket: Bucket,
  address: string,
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const { cap, windowSeconds } = LIMITS[bucket];
  const rows = await db.execute<{ wait: number }>(sql`
    select goals.oauth_claim_call(${bucket}, ${fingerprint(address)}, ${cap}, ${windowSeconds}) as wait`);
  const wait = rows[0].wait;

  return wait === 0 ? { ok: true } : { ok: false, retryAfter: wait };
}

// A registered client by its metadata URL, read before any person exists and without spending a slot.
export async function clientByMetadataUrl(
  url: string,
): Promise<{ id: string; name: string; redirectUris: string[] } | null> {
  const rows = await db.execute<{ id: string; client_name: string; redirect_uris: string[] }>(sql`
    select * from goals.oauth_client_by_metadata_url(${url})`);

  return rows[0] ? { id: rows[0].id, name: rows[0].client_name, redirectUris: rows[0].redirect_uris } : null;
}

export function tooMany(retryAfter: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: "too_many_requests" }), {
    status: 429,
    headers: {
      ...cors,
      "Retry-After": String(retryAfter),
      "Access-Control-Expose-Headers": "Retry-After",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}
