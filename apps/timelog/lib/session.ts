import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { createSupabaseServerClient, verifiedClaims } from "@repo/supabase-auth";
import { withSettledTransaction } from "@repo/supabase-auth/settled-transaction";

import { db } from "@/db/client";
import { env } from "@/lib/env";
import type { ResolvedPerson } from "@/lib/keys";

export type Person = { id: string; email: string };

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const supabaseConfig = {
  url: env.NEXT_PUBLIC_SUPABASE_URL,
  publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
};

// Module level: `verifiedClaims` caches on this reference, so a screen's reads share one `getClaims()`.
function createClient() {
  return createSupabaseServerClient(supabaseConfig);
}

type ActingStore = { user: Person; claims: Record<string, unknown> };

const acting = new AsyncLocalStorage<ActingStore>();

// Runs `fn` as the person a key resolved, with no cookie (RT-07).
export function actAs<T>(person: ResolvedPerson, fn: () => Promise<T>): Promise<T> {
  const user = { id: person.id, email: person.email };

  return acting.run(
    { user, claims: { sub: user.id, email: user.email, role: "authenticated", aud: "authenticated" } },
    fn,
  );
}

export async function getPerson(): Promise<Person | null> {
  const store = acting.getStore();
  if (store) return store.user;

  const session = await verifiedClaims(createClient);
  return session?.user ?? null;
}

/**
 * The only path from the server to TimeLog's tables, as `authenticated` so the policies decide every
 * row (RNT-01). `DATABASE_URL` connects as `postgres`, which bypasses them: without the settle a
 * query returns everyone's rows instead of failing.
 */
export async function withTimeDb<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const session = acting.getStore() ?? (await verifiedClaims(createClient));

  return withSettledTransaction<Transaction, T>(
    session,
    "withTimeDb",
    "timelog, public",
    (cb) => db.transaction(cb),
    (tx, statement) => tx.execute(statement),
    fn,
  );
}
