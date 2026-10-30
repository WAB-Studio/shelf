import "server-only";

import { eq, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import type { Transaction } from "@/db/session";

// RF-156: the row still carries the `updated_at` its form loaded. Parsed from text inside the SQL:
// a parameter bound as `timestamptz` travels through a JS `Date` and loses its microseconds
// (docs/TRAPS.md).
export function stampIs(column: PgColumn, expected: string): SQL<boolean> {
  return sql<boolean>`${column} = ${expected}::text::timestamptz`;
}

// Read only after a stamped write touched nothing: a row still readable means the stamp moved.
export async function staleOrGone(
  tx: Transaction,
  table: PgTable,
  idColumn: PgColumn,
  id: string,
): Promise<"stale" | false> {
  const rows = await tx.select({ id: idColumn }).from(table).where(eq(idColumn, id)).limit(1);
  return rows.length > 0 ? "stale" : false;
}
