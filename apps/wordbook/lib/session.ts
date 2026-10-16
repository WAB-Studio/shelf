import "server-only";

import { createSupabaseServerClient, settleSessionSql, verifiedClaims } from "@repo/supabase-auth";

import { db } from "@/db/client";
import { env } from "@/lib/env";

export type Reader = { id: string; email: string };

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const supabaseConfig = {
  url: env.NEXT_PUBLIC_SUPABASE_URL,
  publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
};

// A module-level function, not a client built inline: `verifiedClaims` wraps
// its work in `cache()`, keyed on this reference, so every call in a request
// that passes it hits the same entry instead of paying its own `getClaims()`.
function createClient() {
  return createSupabaseServerClient(supabaseConfig);
}

// No Postgres round trip: the reader comes straight out of the verified JWT,
// which `verifiedClaims` already deduplicates per request.
export async function getReader(): Promise<Reader | null> {
  const session = await verifiedClaims(createClient);
  return session?.user ?? null;
}

/**
 * The only path from the server to `reading`. Opens a transaction that runs as
 * `authenticated` — a role that neither owns the schema nor holds BYPASSRLS —
 * so the policies decide every row (RNL-10). Without a session there is no
 * query: this throws instead of falling back to an unrestricted connection.
 * This module never sends anyone anywhere else (RNL-09, RL-22) — a screen
 * with no reader draws the sign-up invitation itself.
 */
export async function withReaderDb<T>(
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const session = await verifiedClaims(createClient);
  if (!session) throw new Error("withReaderDb called without a verified session");

  const claims = JSON.stringify(session.claims);

  return db.transaction(async (tx) => {
    // One statement, not four: see `settleSessionSql`.
    await tx.execute(
      settleSessionSql({ claims, searchPath: "reading, public" }),
    );

    return fn(tx);
  });
}
