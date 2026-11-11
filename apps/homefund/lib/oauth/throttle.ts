import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { cors } from "@/lib/http/cors";
import { sha256Hex } from "@/lib/hash";

// RF-168: registration is open to anyone, so each caller address gets this many in a window.
export const REGISTER_LIMIT = { cap: 10, windowSeconds: 3600 } as const;

/**
 * The caller's address: on Vercel `x-vercel-forwarded-for`, which the platform writes and a client cannot set;
 * elsewhere the first value of `x-forwarded-for`. A missing header is one shared `"unknown"`.
 */
export function callerAddress(request: { headers: { get(name: string): string | null } }): string {
  const header = process.env.VERCEL ? "x-vercel-forwarded-for" : "x-forwarded-for";
  return request.headers.get(header)?.split(",")[0].trim() || "unknown";
}

// Counts one call in one statement, so two calls cannot both slip under the cap. Only a hash of the address is stored.
export async function claimRegistration(address: string): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const source = sha256Hex(address);
  const rows = await db.execute<{ wait: number }>(sql`
    select private.claim_oauth_call('register', ${source}, ${REGISTER_LIMIT.cap}, ${REGISTER_LIMIT.windowSeconds}) as wait`);
  const wait = rows[0].wait;

  return wait === 0 ? { ok: true } : { ok: false, retryAfter: wait };
}

export function tooMany(retryAfter: number): Response {
  return new Response(JSON.stringify({ error: "too_many_requests" }), {
    status: 429,
    headers: {
      ...cors("POST"),
      "Retry-After": String(retryAfter),
      "Access-Control-Expose-Headers": "Retry-After",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}
