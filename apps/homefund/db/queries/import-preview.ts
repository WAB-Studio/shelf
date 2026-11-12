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
import { readExport } from "@/db/queries/export";
import { statementKey, type SheetEntity } from "@/lib/spreadsheet/schema";
import { CATEGORY_PATH_SEPARATOR, HELD_KEY_PREFIX, identityKeys } from "@/lib/spreadsheet/sheet-layout";

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
// resolved reference against it before a row that names one ever reaches `parseAmount`.
// Its opening day too (RF-162): a movement row dated before it is refused in the preview.
export type ScopedAccount = ScopedEntity & { settlementCurrency: string; initialBalanceOn: string };

// A category additionally carries its kind (RF-27): a transaction row resolving one
// checks it against the movement's own direction before the row ever reaches a write.
// Its path, «Parent › Child», is what a cell may name it by.
export type ScopedCategory = ScopedEntity & { kind: string; path?: string };

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
  // The stable keys of the rows the fund holds, by the row's identity (RF-179): a file row
  // with no key column adopts the key of the row it repeats, so it updates it, never adds.
  // Several equal rows list their keys in the fund's own order.
  knownKeys: Partial<Record<SheetEntity, Map<string, string[]>>>;
};

// What the file says about the movements it carries, to read only the fund's rows that could
// repeat them: the days they span and the accounts they touch.
export type FileWindow = { from?: string; to?: string; accountNames?: string[] };

// The fund's rows of the entities a file carries, keyed by identity. They come through the
// export, so a cell reads the same on both sides of the comparison. Movements are read in the
// file's own window, in a read of their own beside the rest.
async function readKnownKeys(
  entities: readonly SheetEntity[],
  window: FileWindow,
): Promise<ImportScope["knownKeys"]> {
  const withMovements = entities.includes("transactions");
  const [movements, rest] = await Promise.all([
    withMovements
      ? readExport({ entityKeys: ["transactions"], withKeys: true, ...window })
      : Promise.resolve({}),
    readExport({ entityKeys: entities.filter((entity) => entity !== "transactions"), withKeys: true }),
  ]);
  const data = { ...rest, ...movements } as Record<string, unknown[] | undefined>;
  const known: ImportScope["knownKeys"] = {};
  for (const entity of entities) {
    const keys = new Map<string, string[]>();
    for (const row of (data[entity] ?? []) as Record<string, unknown>[]) {
      const ref = row["externalRef"];
      if (typeof ref !== "string") continue;
      for (const identity of identityKeys(entity, row)) keys.set(identity, [...(keys.get(identity) ?? []), ref]);
    }
    known[entity] = keys;
  }
  return known;
}

// A row the fund holds with no key is still the row a file repeats: it answers to a key made
// of its id, which the commit knows to leave alone.
const keyed = <Row extends { id: string; externalRef: string | null }>(rows: Row[]): Row[] =>
  rows.map((row) => ({ ...row, externalRef: row.externalRef ?? `${HELD_KEY_PREFIX}${row.id}` }));

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

// A category's path through its parents; a level that is missing ends the walk.
function pathOf(
  row: { id: string; name: string; parentId: string | null },
  all: readonly { id: string; name: string; parentId: string | null }[],
): string {
  const byId = new Map(all.map((category) => [category.id, category]));
  const names = [row.name];
  for (let at = row.parentId, hops = 0; at !== null && hops < 8; hops += 1) {
    const parent = byId.get(at);
    if (!parent) break;
    names.unshift(parent.name);
    at = parent.parentId;
  }
  return names.join(CATEGORY_PATH_SEPARATOR);
}

/**
 * The read side of the import pipeline (RF-51/52), all in the caller's RLS scope like
 * `readExport`: the account, category, label and goal rows a reference resolves through, and every
 * entity's existing `external_ref` set for new-vs-update classification. Those four
 * reads carry `external_ref`, so their key sets need no separate trip.
 * The caller's id and fund ride the same fan-out as the entity reads.
 * Each read is its own round trip, fanned out with `Promise.all`, never chained.
 */
export async function readImportScope(
  entities: readonly SheetEntity[] = [],
  window: FileWindow = {},
): Promise<ImportScope> {
  const [
    user,
    group,
    accountRows,
    categoryRowsRaw,
    labelRows,
    goalRows,
    memberRefs,
    recurringRefs,
    transactionRefs,
    restoredKeys,
    knownKeys,
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
            parentId: categories.parentId,
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
      readKnownKeys(entities, window),
    ]);

  const categoryRows = keyed(categoryRowsRaw).map((row) => ({ ...row, path: pathOf(row, categoryRowsRaw) }));
  const held = { accounts: keyed(accountRows), labels: keyed(labelRows), goals: keyed(goalRows) };
  // The rows matched by identity are the rows the fund holds, whether or not they carry a key.
  const refsFound = (entity: SheetEntity, refs: Set<string>): Set<string> => {
    for (const list of knownKeys[entity]?.values() ?? []) for (const ref of list) refs.add(ref);
    return refs;
  };

  return {
    caller: { userId: user.id, groupId: group?.id ?? null },
    accounts: held.accounts,
    categories: categoryRows,
    labels: held.labels,
    goals: held.goals,
    knownKeys,
    existingRefs: {
      accounts: refsFound("accounts", refsOf(held.accounts)),
      categories: refsFound("categories", refsOf(categoryRows)),
      labels: refsFound("labels", refsOf(held.labels)),
      members: refsFound("members", memberRefs),
      recurringRules: refsFound("recurringRules", recurringRefs),
      transactions: refsFound("transactions", transactionRefs),
      budgets: refsFound("budgets", restoredKeys.budgets),
      goals: refsFound("goals", refsOf(held.goals)),
      goalContributions: refsFound("goalContributions", restoredKeys.goalContributions),
      debts: restoredKeys.debts,
      statements: restoredKeys.statements,
    },
  };
}
