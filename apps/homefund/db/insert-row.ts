// The one insert path for a table whose INSERT grant is per column. Drizzle's
// `.insert()` builder names EVERY column of the table and fills the unset ones with
// `default`; Postgres checks the privilege on each named column even then, so a
// builder insert is refused `42501` on a table whose `id`, `created_at`,
// `updated_at`, scope and derived columns are deliberately withheld from
// `authenticated` for the triggers to stamp. This names only what the caller sent.
// No `import "server-only"`, like `db/queries/import-commit.ts`: the package does
// not resolve outside the Next bundler and `scripts/check-rls.ts` imports this.

import { getTableColumns, is, SQL, sql } from "drizzle-orm";
import { CasingCache } from "drizzle-orm/casing";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import type { Transaction } from "@/db/session";

// A column may take its typed value or a raw expression (`now()`, `case … end`).
export type InsertValues<T extends PgTable> = {
  [K in keyof T["$inferInsert"]]?: T["$inferInsert"][K] | SQL;
};

// The alias a caller reads a written column back under.
export type ReturningFields = Record<string, PgColumn>;

export type Returned<R extends ReturningFields> = {
  [K in keyof R]: R[K]["_"]["notNull"] extends true
    ? R[K]["_"]["data"]
    : R[K]["_"]["data"] | null;
};

// Matches `db/client.ts`'s `casing`, so a key maps to the same name the builder
// would have written; `getTableConfig().columns[].name` returns the JS key instead.
const casing = new CasingCache("snake_case");

/**
 * Insert one or more rows naming only the columns the caller provided, in ONE
 * statement and ONE round trip. Runs on the caller's transaction: it opens none
 * and settles no session, because the caller is already inside `withUserDb` or
 * `withImpersonatedDb`. A key that is not a column of the table is a compile
 * error, never a silently dropped value.
 */
export async function insertRow<
  T extends PgTable,
  R extends ReturningFields = Record<string, never>,
>(
  tx: Transaction,
  table: T,
  values: InsertValues<T> | InsertValues<T>[],
  options?: {
    returning?: R;
    // No `set` means `on conflict … do nothing`.
    onConflict?: { target: PgColumn | PgColumn[]; set?: InsertValues<T> };
  },
): Promise<Returned<R>[]> {
  const rows = (Array.isArray(values) ? values : [values]) as Record<
    string,
    unknown
  >[];
  const columns = getTableColumns(table) as Record<string, PgColumn>;

  const columnFor = (key: string): PgColumn => {
    const column = columns[key];
    if (!column) throw new Error(`insertRow: "${key}" is not a column of the table`);
    return column;
  };

  const identifier = (column: PgColumn) =>
    sql.identifier(casing.getColumnCasing(column));

  // The union of the keys carrying a value, in first-seen order: this list is what
  // the grant check reads, so every name on it came from a caller.
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (row[key] === undefined || keys.includes(key)) continue;
      keys.push(key);
    }
  }
  if (keys.length === 0) throw new Error("insertRow: no column to write");

  // A raw expression rides through untouched; anything else binds through the
  // column's own encoder, the path the builder used.
  const cell = (key: string, value: unknown) => {
    if (value === undefined) return sql`default`;
    if (is(value, SQL)) return value;
    return sql.param(value, columnFor(key));
  };

  const columnList = sql.join(
    keys.map((key) => identifier(columnFor(key))),
    sql`, `,
  );

  const valuesList = sql.join(
    rows.map(
      (row) =>
        sql`(${sql.join(
          keys.map((key) => cell(key, row[key])),
          sql`, `,
        )})`,
    ),
    sql`, `,
  );

  let conflict = sql``;
  if (options?.onConflict) {
    const { target, set } = options.onConflict;
    const targetList = sql.join(
      (Array.isArray(target) ? target : [target]).map(identifier),
      sql`, `,
    );
    const setEntries = Object.entries((set ?? {}) as Record<string, unknown>).filter(
      ([, value]) => value !== undefined,
    );

    conflict =
      setEntries.length > 0
        ? sql` on conflict (${targetList}) do update set ${sql.join(
            setEntries.map(
              ([key, value]) => sql`${identifier(columnFor(key))} = ${cell(key, value)}`,
            ),
            sql`, `,
          )}`
        : sql` on conflict (${targetList}) do nothing`;
  }

  const returning = options?.returning;
  const aliases = returning ? Object.keys(returning) : [];
  const returningList =
    aliases.length > 0
      ? sql` returning ${sql.join(
          aliases.map(
            (alias) => sql`${identifier(returning![alias])} as ${sql.identifier(alias)}`,
          ),
          sql`, `,
        )}`
      : sql``;

  const written = await tx.execute<Record<string, unknown>>(
    sql`insert into ${table} (${columnList}) values ${valuesList}${conflict}${returningList}`,
  );

  if (aliases.length === 0) return [];

  // The driver hands a bigint back as a string; the column's decoder is what turns
  // it into the number the ledger keeps.
  return written.map((row) => {
    const mapped: Record<string, unknown> = {};
    for (const alias of aliases) {
      const value = row[alias];
      mapped[alias] =
        value === null || value === undefined
          ? null
          : returning![alias].mapFromDriverValue(value);
    }
    return mapped as Returned<R>;
  });
}
