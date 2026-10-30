import "server-only";

import { isNotNull, sql } from "drizzle-orm";

import {
  accountStatements,
  accounts,
  budgets,
  categories,
  debtTerms,
  goalContributions,
  groupMembers,
  labels,
  recurringRules,
  savingsGoals,
  transactions,
} from "@/db/schema";
import { getUserGroup } from "@/db/queries/groups";
import { requireUser, withUserDb } from "@/db/session";
import { statementKey, type SheetEntity } from "@/lib/spreadsheet/schema";

// The tables whose `external_ref` set is read on its own: the rest come with their rows or with
// `readRestoredKeys`. A row's `external_ref` is its stable per-scope import key (RF-52): present
// in the scope means an update, absent means a new row.
const refTables = {
  members: groupMembers,
  recurringRules,
  transactions,
};

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
  goals: ScopedEntity[];
  existingRefs: Record<SheetEntity, Set<string>>;
};

// The set of `external_ref` values already in the caller's scope for one entity,
// the null-guarded index the classification matches on (RF-52).
async function readExistingRefs(entity: keyof typeof refTables): Promise<Set<string>> {
  const table = refTables[entity] as typeof transactions;
  return withUserDb(async (tx) => {
    const rows = await tx
      .select({ ref: table.externalRef })
      .from(table)
      .where(isNotNull(table.externalRef));
    return new Set(rows.map((row) => row.ref as string));
  });
}

type RestoredEntity = "budgets" | "goalContributions" | "debts" | "statements";

// The keys of the four entities only a backup restores, in one trip: budgets and contributions by
// their `external_ref`, an account's terms by the account (RF-78), a closed statement by its
// account and cut-off (RF-129).
async function readRestoredKeys(): Promise<Record<RestoredEntity, Set<string>>> {
  return withUserDb(async (tx) => {
    const rows = await tx.execute<{ entity: RestoredEntity; key: string; day: string | null }>(sql`
      select 'budgets' as entity, external_ref as key, null::text as day from ${budgets} where external_ref is not null
      union all
      select 'goalContributions', external_ref, null from ${goalContributions} where external_ref is not null
      union all
      select 'debts', account_id::text, null from ${debtTerms}
      union all
      select 'statements', account_id::text, cut_off_date::text from ${accountStatements}`);
    const keys: Record<RestoredEntity, Set<string>> = {
      budgets: new Set(),
      goalContributions: new Set(),
      debts: new Set(),
      statements: new Set(),
    };
    for (const row of rows) keys[row.entity].add(row.day === null ? row.key : statementKey(row.key, row.day));
    return keys;
  });
}

// The stable keys present among a set of scoped rows, for the entities whose id
// and name are read anyway — no extra round trip for their `existingRefs` set.
function refsOf(rows: ScopedEntity[]): Set<string> {
  return new Set(rows.filter((row) => row.externalRef != null).map((row) => row.externalRef as string));
}

/**
 * The read side of the import pipeline (RF-51/52), all in the caller's RLS scope like
 * `readExport`: the account, category, label and goal rows a reference resolves through, and every
 * entity's existing `external_ref` set for new-vs-update classification. Those four
 * reads carry `external_ref`, so their key sets need no separate trip.
 * The caller's id and fund ride the same fan-out as the entity reads.
 * Each read is its own round trip, fanned out with `Promise.all`, never chained.
 */
export async function readImportScope(): Promise<ImportScope> {
  const [
    user,
    group,
    accountRows,
    categoryRows,
    labelRows,
    goalRows,
    memberRefs,
    recurringRefs,
    transactionRefs,
    restoredKeys,
  ] =
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
      withUserDb((tx) =>
        tx
          .select({
            id: savingsGoals.id,
            name: savingsGoals.name,
            externalRef: savingsGoals.externalRef,
            ownerUserId: savingsGoals.ownerUserId,
            groupId: savingsGoals.groupId,
          })
          .from(savingsGoals),
      ),
      readExistingRefs("members"),
      readExistingRefs("recurringRules"),
      readExistingRefs("transactions"),
      readRestoredKeys(),
    ]);

  return {
    caller: { userId: user.id, groupId: group?.id ?? null },
    accounts: accountRows,
    categories: categoryRows,
    labels: labelRows,
    goals: goalRows,
    existingRefs: {
      accounts: refsOf(accountRows),
      categories: refsOf(categoryRows),
      labels: refsOf(labelRows),
      members: memberRefs,
      recurringRules: recurringRefs,
      transactions: transactionRefs,
      budgets: restoredKeys.budgets,
      goals: refsOf(goalRows),
      goalContributions: restoredKeys.goalContributions,
      debts: restoredKeys.debts,
      statements: restoredKeys.statements,
    },
  };
}
