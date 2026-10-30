import "server-only";

import { isNotNull } from "drizzle-orm";

import {
  accounts,
  categories,
  groupMembers,
  labels,
  recurringRules,
  transactions,
} from "@/db/schema";
import { getUserGroup } from "@/db/queries/groups";
import { requireUser, withUserDb } from "@/db/session";
import { type SheetEntity } from "@/lib/spreadsheet/schema";

// The table each entity's `external_ref` lives on, keyed by the import's entity
// names. A row's `external_ref` is its stable per-scope import key (RF-52): present
// in the scope means an update, absent means a new row.
const refTables = {
  accounts,
  members: groupMembers,
  categories,
  labels,
  recurringRules,
  transactions,
} as const;

// One referenced entity as the resolver needs it: its real id, its current name, and
// its stable key, so a file row that renames it (matched by key) can override the
// name in the effective post-import set. `ownerUserId` and `groupId` say which scope
// it lives in: exactly one is set (personal or fund), never both.
export type ScopedEntity = {
  id: string;
  name: string;
  externalRef: string | null;
  ownerUserId: string | null;
  groupId: string | null;
};

// An account additionally carries what it settles in (RF-121): the pipeline checks a
// resolved reference against it before a row that names one ever reaches `parsePesos`.
// Its opening day too (RF-162): a movement row dated before it is refused in the preview.
export type ScopedAccount = ScopedEntity & { settlementCurrency: string; initialBalanceOn: string };

// A category additionally carries its kind (RF-27): a transaction row resolving one
// checks it against the movement's own direction before the row ever reaches a write.
export type ScopedCategory = ScopedEntity & { kind: string };

// The caller's existing scope, read once so the pipeline resolves references and
// classifies rows without touching Postgres again. The account and category rows
// seed the effective post-import set a reference resolves against; `existingRefs`
// is the per-entity stable-key set the new-vs-update classification matches on.
// `caller` is who imports and the fund a file-new row lands in, if any.
export type ImportScope = {
  caller: { userId: string; groupId: string | null };
  accounts: ScopedAccount[];
  categories: ScopedCategory[];
  labels: ScopedEntity[];
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

// The stable keys present among a set of scoped rows, for the entities whose id
// and name are read anyway — no extra round trip for their `existingRefs` set.
function refsOf(rows: ScopedEntity[]): Set<string> {
  return new Set(rows.filter((row) => row.externalRef != null).map((row) => row.externalRef as string));
}

/**
 * The read side of the import pipeline (RF-51/52), all in the caller's RLS scope like
 * `readExport`: the account, category and label rows a reference resolves through, and every
 * entity's existing `external_ref` set for new-vs-update classification. Those three
 * reads carry `external_ref`, so their key sets need no separate trip.
 * The caller's id and fund ride the same fan-out as the entity reads.
 * Each read is its own round trip, fanned out with `Promise.all`, never chained.
 */
export async function readImportScope(): Promise<ImportScope> {
  const [user, group, accountRows, categoryRows, labelRows, memberRefs, recurringRefs, transactionRefs] =
    await Promise.all([
      requireUser(),
      getUserGroup(),
      withUserDb((tx) =>
        tx
          .select({
            id: accounts.id,
            name: accounts.name,
            externalRef: accounts.externalRef,
            ownerUserId: accounts.ownerUserId,
            groupId: accounts.groupId,
            settlementCurrency: accounts.settlementCurrency,
            initialBalanceOn: accounts.initialBalanceOn,
          })
          .from(accounts),
      ),
      withUserDb((tx) =>
        tx
          .select({
            id: categories.id,
            name: categories.name,
            externalRef: categories.externalRef,
            ownerUserId: categories.ownerUserId,
            groupId: categories.groupId,
            kind: categories.kind,
          })
          .from(categories),
      ),
      withUserDb((tx) =>
        tx
          .select({
            id: labels.id,
            name: labels.name,
            externalRef: labels.externalRef,
            ownerUserId: labels.ownerUserId,
            groupId: labels.groupId,
          })
          .from(labels),
      ),
      readExistingRefs("members"),
      readExistingRefs("recurringRules"),
      readExistingRefs("transactions"),
    ]);

  return {
    caller: { userId: user.id, groupId: group?.id ?? null },
    accounts: accountRows,
    categories: categoryRows,
    labels: labelRows,
    existingRefs: {
      accounts: refsOf(accountRows),
      categories: refsOf(categoryRows),
      labels: refsOf(labelRows),
      members: memberRefs,
      recurringRules: recurringRefs,
      transactions: transactionRefs,
    },
  };
}
