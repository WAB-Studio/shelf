import { settleSessionSql } from "@repo/supabase-auth/settle";
import type { SQL } from "drizzle-orm";

export type VerifiedSession = { claims: Record<string, unknown> };

/**
 * The guard-and-settle body every door to this app's tables runs before a
 * query (RNP-05): throws before any connection is taken when there is no
 * session, otherwise opens the caller's own transaction and settles it with
 * `settleSessionSql` before running `fn`.
 *
 * No `next/headers`, no `server-only`, no `@/db/client`: `begin` opens the
 * caller's own transaction and `run` executes a statement on it, so
 * `lib/session.ts` passes drizzle's `db.transaction`/`tx.execute` and a
 * script driving its own `postgres` connection passes its own — both call
 * this one function, never a copy of it, which is what lets a mutation here
 * be caught wherever it is called from.
 */
export async function withSettledTransaction<Tx, T>(
  session: VerifiedSession | null,
  label: string,
  searchPath: string,
  begin: (fn: (tx: Tx) => Promise<T>) => Promise<T>,
  run: (tx: Tx, statement: SQL) => Promise<unknown>,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!session) throw new Error(`${label} called without a verified session`);

  const claims = JSON.stringify(session.claims);

  return begin(async (tx) => {
    // Inlined: under `prepare: false` postgres.js sends any statement with a
    // bind parameter describe-first and holds the connection until Postgres
    // answers (`postgres/src/connection.js:238`), so a parameterized settle
    // could never share a round trip with `fn`'s first statement. drizzle
    // quotes each value as a string literal with every `'` doubled
    // (`drizzle-orm/pg-core/dialect.js:79`); `scripts/plan/settle-inline.ts`
    // proves no claim leaves it.
    // `.then` is called here, not on first await: drizzle's query is lazy, and
    // this is what puts the settle on the wire ahead of `fn`'s statement.
    const settled = run(tx, settleSessionSql({ claims, searchPath }).inlineParams()).then(() => undefined);

    // Wrapped once: `fn` may hand back drizzle's lazy query itself, which runs
    // again on every `.then`. A throw inside `fn` lands here as a rejection.
    const result = new Promise<T>((resolve) => resolve(fn(tx)));
    // `fn` is waited out even when the settle failed: rejecting first would
    // roll back while `fn` still runs, and its next statement would reach the
    // bare connection as `postgres`, past RLS. Inside the aborted transaction
    // every statement it sends fails instead.
    const [settle] = await Promise.allSettled([settled, result]);
    if (settle.status === "rejected") throw settle.reason;
    return result;
  });
}
