import "server-only";

import { and, asc, eq, exists, gte, lte, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import { transactionListConditions } from "@/db/queries/transactions";
import type { TransactionListFilters } from "@/db/queries/transactions";
import {
  accounts,
  budgets,
  categories,
  goalContributions,
  groupMembers,
  labels,
  recurringRules,
  savingsGoals,
  transactionLabels,
  transactions,
  transactionSplits,
} from "@/db/schema";
import { withUserDb } from "@/db/session";
import { TIME_ZONE } from "@/lib/locales";
import { SHEET_ENTITIES, sheetDescriptors } from "@/lib/spreadsheet/schema";
import { LABEL_SEPARATOR, type RefEntity, type SheetEntity } from "@/lib/spreadsheet/schema";
import { ACCOUNT_PLACEMENTS } from "@/lib/validation/account";

// The table each entity reads from, keyed by the export's own entity names.
const exportTables = {
  accounts,
  members: groupMembers,
  categories,
  labels,
  recurringRules,
  transactions,
  budgets,
  goals: savingsGoals,
  goalContributions,
} as const;

// A parsed cell holds a resolved name, a scalar, integer cents or nothing; never a
// raw uuid, which would mean nothing after a dev→prod restore (RF-49).
type CellValue = string | number | boolean | null;

// The keys a sheet row carries are the descriptor's column keys, in its order.
type KeyOf<E extends SheetEntity> =
  (typeof sheetDescriptors)[E]["columns"][number]["key"];

// One export row: every descriptor column keyed by its sheet key. Reference cells
// hold names, money cells stay integer cents (RNF-05), the rest pass through.
export type ExportRow<E extends SheetEntity> = Record<KeyOf<E>, CellValue>;

// Only the requested entities are read, so an absent key means "not asked for",
// distinct from a key present with an empty array.
export type ExportResult = Partial<{ [E in SheetEntity]: ExportRow<E>[] }>;

// The movement list's own filters, less the range the export already bounds and
// the single-id lookup only a detail page uses.
export type TransactionExportFilters = Omit<TransactionListFilters, "id" | "from" | "to">;

export type ExportInput = {
  entityKeys: SheetEntity[];
  from?: Date | string;
  to?: Date | string;
  // Narrows the transactions sheet alone (RF-118); the other four entities stay
  // the whole-fund dump RF-50 asks for.
  transactionFilters?: TransactionExportFilters;
};

// The date range bounds only the two dated entities, on the field the descriptor
// treats as their calendar day. Both are `date` columns already interpreted in
// America/Bogota (RNF-06), so a civil-date string compares directly — no
// `at time zone` cast, unlike the timestamp the audit trail bounds.
const dateColumn: Partial<Record<SheetEntity, PgColumn>> = {
  transactions: transactions.occurredAt,
  recurringRules: recurringRules.nextRunOn,
};

// Movements leave in the order they happened, so two backups of the same ledger
// list it alike and twin rows keep their relative place; heap order shifts with
// every update.
const chronological = [asc(transactions.occurredAt), asc(transactions.createdAt), asc(transactions.id)];

// A Date bound reads back as its own Bogotá day; a string is already a civil date.
function toCivilDate(value: Date | string): string {
  if (typeof value === "string") return value;
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(value);
}

// One column seen through the shared contract: `satisfies` narrows each literal, so
// only some carry `ref`; this view restores the optional markers for iteration.
// A field-backed column reads its `$inferSelect` column; a synthetic one (the
// transaction category) has none and is filled from a related row instead.
type ColumnView =
  | {
      readonly key: string;
      readonly field: string;
      readonly ref?: { readonly entity: RefEntity };
      readonly flag?: true;
    }
  | {
      readonly key: string;
      readonly synthetic: true;
      readonly ref?: { readonly entity: RefEntity };
    };

// True when an entity's descriptor points at the given entity by name, so its name
// map is worth a round trip.
function referencesEntity(entity: SheetEntity, ref: RefEntity): boolean {
  const columns = sheetDescriptors[entity].columns as readonly ColumnView[];
  return columns.some((column) => column.ref?.entity === ref);
}

// One entity's raw rows, projected to exactly the descriptor's id-shaped fields.
// RLS scopes every row to the caller — personal plus their group's — so no manual
// scope filter joins the range predicates; the policy alone bounds the read.
async function readEntityRows<E extends SheetEntity>(
  entity: E,
  from: Date | string | undefined,
  to: Date | string | undefined,
  extra: SQL[],
): Promise<Record<string, unknown>[]> {
  const descriptor = sheetDescriptors[entity];
  const table = exportTables[entity];
  const columns = table as unknown as Record<string, PgColumn>;
  const descriptorColumns = descriptor.columns as readonly ColumnView[];

  const projection: Record<string, PgColumn> = {};
  for (const column of descriptorColumns) {
    // A synthetic column (the transaction category) has no model column to select.
    if ("synthetic" in column) continue;
    projection[column.field] = columns[column.field];
  }

  // No descriptor names a transaction's id anymore, yet the category fill matches
  // a split back to its row by it; carry it so `toExportRows` can look it up.
  if (entity === "transactions") projection["id"] = columns["id"];

  const bound = dateColumn[entity];
  const conditions: SQL[] = [...extra];
  if (bound) {
    if (from) conditions.push(gte(bound, toCivilDate(from)));
    if (to) conditions.push(lte(bound, toCivilDate(to)));
  }

  return withUserDb(async (tx) => {
    // The table is a union across the five entities; a single concrete type lets
    // the query builder resolve `.from`, and the projection carries the shape.
    const rows = await tx
      .select(projection)
      .from(table as typeof accounts)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(...(entity === "transactions" ? chronological : []));

    return rows as Record<string, unknown>[];
  });
}

// The caller's id→name map for one referenced entity, read in the caller's RLS
// scope so a reference resolves to a name the same scope can read back.
async function readNameMap(
  table: typeof accounts | typeof categories | typeof labels | typeof savingsGoals,
): Promise<Map<string, string>> {
  return withUserDb(async (tx) => {
    const rows = await tx.select({ id: table.id, name: table.name }).from(table as typeof accounts);
    return new Map(rows.map((row) => [row.id, row.name]));
  });
}

// A movement goes by its own key (RF-52): the only one of its names a restore keeps.
async function readMovementKeys(): Promise<Map<string, string>> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .select({ id: transactions.id, ref: transactions.externalRef })
      .from(transactions)
      .where(exists(tx.select({ present: sql`1` }).from(goalContributions).where(eq(goalContributions.transactionId, transactions.id))));
    return new Map(rows.flatMap((row) => (row.ref !== null ? [[row.id, row.ref] as const] : [])));
  });
}

const emptyNameMap = new Map<string, string>();

// Each transaction's split category ids (RF-69), or its label ids (RF-70), grouped by
// transaction. Read in the caller's RLS scope so an id resolves to a name the same scope
// reads back. One round trip for the whole child table; the fill picks the ids of the
// transactions it exports and ignores the rest. A filtered export carries the list's
// predicates into the same round trip, so it never reads the whole ledger's children to
// fill a handful of cells (RNF-15).
async function readLinkedIds(
  child: typeof transactionSplits | typeof transactionLabels,
  linked: PgColumn,
  conditions: SQL[],
): Promise<Map<string, string[]>> {
  return withUserDb(async (tx) => {
    const exported =
      conditions.length === 0
        ? undefined
        : exists(
            tx
              .select({ present: sql`1` })
              .from(transactions)
              .where(and(eq(transactions.id, child.transactionId), ...conditions)),
          );

    const rows = await tx
      .select({ transactionId: child.transactionId, linkedId: linked })
      .from(child as typeof transactionSplits)
      .where(exported);

    const byTransaction = new Map<string, string[]>();
    for (const row of rows) {
      const ids = byTransaction.get(row.transactionId) ?? [];
      ids.push(row.linkedId as string);
      byTransaction.set(row.transactionId, ids);
    }
    return byTransaction;
  });
}

const emptyLinkMap = new Map<string, string[]>();

// Every id→name map a reference cell reads, keyed by the entity it names.
type NameMaps = Record<RefEntity, Map<string, string>>;

// A transaction's children, by transaction id.
type Children = { splitCategoryIds: Map<string, string[]>; labelIds: Map<string, string[]> };

// One raw row turned into its sheet shape: a reference to its name, `placement` to
// a personal/group indicator, money left in integer cents (RNF-05), scalars as is.
function toExportRows<E extends SheetEntity>(
  entity: E,
  rows: Record<string, unknown>[],
  names: NameMaps,
  children: Children,
): ExportRow<E>[] {
  const columns = sheetDescriptors[entity].columns as readonly ColumnView[];

  return rows.map((row) => {
    const cell: Record<string, CellValue> = {};

    for (const column of columns) {
      if ("synthetic" in column && column.key === "labels") {
        // Every label the movement carries, by name, in one cell; none leaves it blank.
        const named = (children.labelIds.get(row.id as string) ?? []).flatMap((id) => names.labels.get(id) ?? []);
        cell[column.key] = named.length > 0 ? named.sort().join(LABEL_SEPARATOR) : null;
        continue;
      }

      if ("synthetic" in column) {
        // A transaction's category (RF-69): the name of its SINGLE split. Zero splits
        // (a transfer) or more than one (no faithful single cell) leave it blank.
        const ids = children.splitCategoryIds.get(row.id as string) ?? [];
        cell[column.key] = ids.length === 1 ? names.categories.get(ids[0]) ?? null : null;
        continue;
      }

      const value = row[column.field];

      if (column.flag) {
        cell[column.key] = value == null ? null : true;
        continue;
      }

      // The estimate mark belongs to a second amount: a movement with none leaves the
      // cell blank rather than the column's FALSE (RF-123).
      if (entity === "transactions" && column.field === "counterIsEstimate") {
        cell[column.key] = row.counterAmountCents == null ? null : (value as boolean);
        continue;
      }

      if (column.ref) {
        // A reference presents the referenced row's name; a null id (a one-sided
        // movement) or a name outside the caller's scope yields null.
        cell[column.key] = value == null ? null : names[column.ref.entity].get(value as string) ?? null;
        continue;
      }

      // `placement` has no column of its own: a row naming an owner is personal, one
      // naming a group is group (RF-60), derived from `ownerUserId`.
      if (column.key === "placement") {
        cell[column.key] = value == null ? ACCOUNT_PLACEMENTS[1] : ACCOUNT_PLACEMENTS[0];
        continue;
      }

      if (column.key === "contributedOn") {
        cell[column.key] = toCivilDate(value as Date);
        continue;
      }

      cell[column.key] = (value ?? null) as CellValue;
    }

    return cell as ExportRow<E>;
  });
}

/**
 * Every requested entity in export shape, each in its own round trip so the reads
 * fan out (RF-50), the two name maps alongside them — never chained. RLS bounds
 * each set to the caller's scope: a caller with no group reads their personal rows
 * and no members, since the members policy shows only a group's roster. References
 * resolve to names (RF-49); money stays integer cents, the sheet's cents→pesos
 * boundary a later module's. Transfers stay in the transactions set: RF-19's
 * report-only exclusion does not reach a backup. Filters narrow the transactions
 * sheet to what the ledger list shows (RF-118) and leave the other four sheets
 * whole; with none, every read is the one the unfiltered export already ran.
 */
export async function readExport(input: ExportInput): Promise<ExportResult> {
  const requested = SHEET_ENTITIES.filter((entity) => input.entityKeys.includes(entity));

  const needsAccounts = requested.some((entity) => referencesEntity(entity, "accounts"));
  const needsCategories = requested.some((entity) => referencesEntity(entity, "categories"));
  const needsLabels = requested.some((entity) => referencesEntity(entity, "labels"));
  const needsGoals = requested.some((entity) => referencesEntity(entity, "goals"));
  const needsMovementKeys = requested.some((entity) => referencesEntity(entity, "transactions"));
  const needsSplits = requested.includes("transactions");

  // Built once so the rows and their splits are narrowed by the very same set.
  const listed = input.transactionFilters
    ? transactionListConditions(input.transactionFilters)
    : [];

  const [sets, accountNames, categoryNames, labelNames, goalNames, movementKeys, splitCategoryIds, labelIds] = await Promise.all([
    Promise.all(
      requested.map((entity) =>
        readEntityRows(
          entity,
          input.from,
          input.to,
          // An adjustment is a movement like any other here: the list shows it (RF-118) and a
          // re-import must reproduce each reconciled account's balance (RF-50).
          entity === "transactions" ? listed : [],
        ),
      ),
    ),
    needsAccounts ? readNameMap(accounts) : Promise.resolve(emptyNameMap),
    needsCategories ? readNameMap(categories) : Promise.resolve(emptyNameMap),
    needsLabels ? readNameMap(labels) : Promise.resolve(emptyNameMap),
    needsGoals ? readNameMap(savingsGoals) : Promise.resolve(emptyNameMap),
    needsMovementKeys ? readMovementKeys() : Promise.resolve(emptyNameMap),
    needsSplits ? readLinkedIds(transactionSplits, transactionSplits.categoryId, listed) : Promise.resolve(emptyLinkMap),
    needsSplits ? readLinkedIds(transactionLabels, transactionLabels.labelId, listed) : Promise.resolve(emptyLinkMap),
  ]);

  const names: NameMaps = {
    accounts: accountNames,
    categories: categoryNames,
    labels: labelNames,
    goals: goalNames,
    transactions: movementKeys,
  };
  const children: Children = { splitCategoryIds, labelIds };

  const result: ExportResult = {};
  requested.forEach((entity, index) => {
    result[entity] = toExportRows(entity, sets[index], names, children) as never;
  });

  return result;
}
