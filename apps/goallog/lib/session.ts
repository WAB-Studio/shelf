import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import {
  createSupabaseServerClient,
  verifiedClaims,
} from "@repo/supabase-auth";

import { db } from "@/db/client";
import { env } from "@/lib/env";
import type { ResolvedPerson } from "@/lib/mcp/tokens";
import { withSettledTransaction } from "@/lib/settled-transaction";

export type Person = { id: string; email: string };

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const supabaseConfig = {
  url: env.NEXT_PUBLIC_SUPABASE_URL,
  publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
};

// A module-level function, not a client built inline: `verifiedClaims` wraps its
// work in `cache()`, keyed on this reference, so the day's screen and every
// query it fans out share one entry instead of paying a `getClaims()` each.
function createClient() {
  return createSupabaseServerClient(supabaseConfig);
}

type ActingStore = { user: Person; claims: Record<string, unknown> };

const acting = new AsyncLocalStorage<ActingStore>();

/**
 * Runs `fn` as a person a bearer key already resolved, with no cookie: inside
 * it `getPerson()` and every door below take this person instead of the
 * request's. `run`, not `enterWith`, so the store ends with `fn` and never
 * leaks into the caller's continuation.
 */
export function actAs<T>(person: ResolvedPerson, fn: () => Promise<T>): Promise<T> {
  const user = { id: person.id, email: person.email };

  return acting.run(
    {
      user,
      claims: { sub: user.id, email: user.email, role: "authenticated", aud: "authenticated" },
    },
    fn,
  );
}

// No Postgres round trip: the person comes straight out of the verified JWT.
export async function getPerson(): Promise<Person | null> {
  const store = acting.getStore();
  if (store) return store.user;

  const session = await verifiedClaims(createClient);

  return session?.user ?? null;
}

/**
 * Every door below runs as `authenticated`, a role that owns none of these
 * tables and holds no BYPASSRLS, so the policies decide every row (RNP-05).
 * `DATABASE_URL` connects as `postgres`, which does bypass them: without this
 * settle a query does not fail, it quietly returns everyone's rows.
 *
 * The guard and the settle themselves live in `withSettledTransaction`
 * (`@/lib/settled-transaction`), not here: that function holds no
 * `next/headers` and no `@/db/client`, so `apps/pulsar/scripts/check-policies.ts`
 * calls the very same one instead of a copy of it, and a mutation to either
 * is caught from both places.
 */
async function withSettledDb<T>(
  door: string,
  searchPath: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const session = acting.getStore() ?? (await verifiedClaims(createClient));

  return withSettledTransaction<Transaction, T>(
    session,
    door,
    searchPath,
    (cb) => db.transaction(cb),
    (tx, statement) => tx.execute(statement),
    fn,
  );
}

// The only path from the server to this app's own tables.
export async function withGoalsDb<T>(
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withSettledDb("withGoalsDb", "goals, public", fn);
}

/**
 * The only path to another app's evidence, read under the person's own identity
 * so that app's policies are what allow it (RP-10). A door of its own, not a
 * `search_path` argument on the one above: `goals` is never in scope while
 * evidence is read, and a source that cannot be read fails inside its own
 * transaction, where its caller catches it without touching the day (RNP-04).
 */
export async function withReadingDb<T>(
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withSettledDb("withReadingDb", "reading, public", fn);
}
