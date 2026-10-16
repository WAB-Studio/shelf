import "server-only";

import { isNotNull } from "drizzle-orm";

import {
  accounts,
  categories,
  groupMembers,
  recurringRules,
  transactions,
} from "@/db/schema";
import { withUserDb } from "@/db/session";
import { type SheetEntity } from "@/lib/spreadsheet/schema";

// The table each entity's `external_ref` lives on, keyed by the import's entity
// names. A row's `external_ref` is its stable per-scope import key (RF-52): present
// in the scope means an update, absent means a new row.
const refTables = {
  accounts,
  members: groupMembers,
  categories,
  recurringRules,
  transactions,
} as const;

// One referenced entity as the resolver needs it: its real id, its current name, and
// its stable key, so a file row that renames it (matched by key) can override the
// name in the effective post-import set.
export type ScopedEntity = {
  id: string;
  name: string;
  externalRef: string | null;
};

// An account additionally carries what it settles in (RF-121): the pipeline checks a
// resolved reference against it before a row that names one ever reaches `parsePesos`.
export type ScopedAccount = ScopedEntity & { settlementCurrency: string };

// A category additionally carries its kind (RF-27): a transaction row resolving one
// checks it against the movement's own direction before the row ever reaches a write.
export type ScopedCategory = ScopedEntity & { kind: string };

// The caller's existing scope, read once so the pipeline resolves references and
// classifies rows without touching Postgres again. The account and category rows
// seed the effective post-import set a reference resolves against; `existingRefs`
// is the per-entity stable-key set the new-vs-update classification matches on.
export type ImportScope = {
  accounts: ScopedAccount[];
  categories: ScopedCategory[];
  existingRefs: Record<SheetEntity, Set<string>>;
};

// The set of `external_ref` values already in the caller's scope for one entity,
// the null-guarded index the classification matches on (RF-52).
async function readExistingRefs(entity: SheetEntity): Promise<Set<string>> {
  const table = refTables[entity];
  return withUserDb(async (tx) => {
    const rows = await tx
      .select({ ref: table.externalRef })
      .from(table as typeof accounts)
      .where(isNotNull(table.externalRef));
    return new Set(rows.map((row) => row.ref as string));
  });
}

// The stable keys present among a set of scoped rows, for the two entities whose id
// and name are read anyway — no extra round trip for their `existingRefs` set.
function refsOf(rows: ScopedEntity[]): Set<string> {
  return new Set(rows.filter((row) => row.externalRef != null).map((row) => row.externalRef as string));
}

/**
 * The read side of the import pipeline (RF-51/52), all in the caller's RLS scope like
 * `readExport`: the account and category rows a reference resolves through, and every
 * entity's existing `external_ref` set for new-vs-update classification. The accounts
 * and categories reads carry `external_ref`, so their key sets need no separate trip.
 * Each read is its own round trip, fanned out with `Promise.all`, never chained.
 */
export async function readImportScope(): Promise<ImportScope> {
  const [accountRows, categoryRows, memberRefs, recurringRefs, transactionRefs] =
    await Promise.all([
      withUserDb((tx) =>
        tx
          .select({
            id: accounts.id,
            name: accounts.name,
            externalRef: accounts.externalRef,
            settlementCurrency: accounts.settlementCurrency,
          })
          .from(accounts),
      ),
      withUserDb((tx) =>
        tx
          .select({
            id: categories.id,
            name: categories.name,
            externalRef: categories.externalRef,
            kind: categories.kind,
          })
          .from(categories),
      ),
      readExistingRefs("members"),
      readExistingRefs("recurringRules"),
      readExistingRefs("transactions"),
    ]);

  return {
    accounts: accountRows,
    categories: categoryRows,
    existingRefs: {
      accounts: refsOf(accountRows),
      categories: refsOf(categoryRows),
      members: memberRefs,
      recurringRules: recurringRefs,
      transactions: transactionRefs,
    },
  };
}
