import "server-only";

import { and, eq, exists, gte, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import type { TransactionListFilters } from "@/db/queries/transactions";
import {
  accounts,
  categories,
  groupMembers,
  recurringRules,
  transactionLabels,
  transactions,
  transactionSplits,
} from "@/db/schema";
import { withUserDb } from "@/db/session";
import { TIME_ZONE } from "@/lib/locales";
import { SHEET_ENTITIES, sheetDescriptors } from "@/lib/spreadsheet/schema";
import type { SheetEntity } from "@/lib/spreadsheet/schema";
import { ACCOUNT_PLACEMENTS } from "@/lib/validation/account";

// The table each entity reads from, keyed by the export's own entity names.
const exportTables = {
  accounts,
  members: groupMembers,
  categories,
  recurringRules,
  transactions,
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

// A Date bound reads back as its own Bogotá day; a string is already a civil date.
function toCivilDate(value: Date | string): string {
  if (typeof value === "string") return value;
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(value);
}

// The ledger list's own predicates, rebuilt over the same columns so the export
// narrows to exactly the rows the list shows (RF-23, RF-89). An absent filter
// adds nothing, so an unfiltered export runs the query it ran before.
function transactionConditions(filters?: TransactionExportFilters): SQL[] {
  const conditions: SQL[] = [];
  if (!filters) return conditions;

  if (filters.memberUserId) {
    conditions.push(eq(transactions.createdBy, filters.memberUserId));
  }
  if (filters.accountId) {
    conditions.push(
      or(
        eq(transactions.fromAccountId, filters.accountId),
        eq(transactions.toAccountId, filters.accountId),
      ) as SQL,
    );
  }
  if (filters.categoryId) {
    conditions.push(
      sql`exists (select 1 from ${transactionSplits} s
        where s.transaction_id = ${transactions.id} and s.category_id = ${filters.categoryId})`,
    );
  }
  if (filters.labelId) {
    conditions.push(
      sql`exists (select 1 from ${transactionLabels} tl
        where tl.transaction_id = ${transactions.id} and tl.label_id = ${filters.labelId})`,
    );
  }
  if (filters.kind) conditions.push(eq(transactions.kind, filters.kind));
  if (filters.unreviewed) {
    conditions.push(
      and(
        isNotNull(transactions.recurringRuleId),
        isNull(transactions.reviewedAt),
      ) as SQL,
    );
  }
  if (filters.recurringRuleId) {
    conditions.push(eq(transactions.recurringRuleId, filters.recurringRuleId));
  }

  return conditions;
}

// One column seen through the shared contract: `satisfies` narrows each literal, so
// only some carry `ref`; this view restores the optional markers for iteration.
// A field-backed column reads its `$inferSelect` column; a synthetic one (the
// transaction category) has none and is filled from a related row instead.
type ColumnView =
  | {
      readonly key: string;
      readonly field: string;
      readonly ref?: { readonly entity: "accounts" | "categories" };
    }
  | {
      readonly key: string;
      readonly synthetic: true;
      readonly ref?: { readonly entity: "accounts" | "categories" };
    };

// True when an entity's descriptor points at the given entity by name, so its name
// map is worth a round trip.
function referencesEntity(entity: SheetEntity, ref: "accounts" | "categories"): boolean {
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
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    return rows as Record<string, unknown>[];
  });
}

// The caller's id→name map for one referenced entity, read in the caller's RLS
// scope so a reference resolves to a name the same scope can read back.
async function readNameMap(table: typeof accounts | typeof categories): Promise<Map<string, string>> {
  return withUserDb(async (tx) => {
    const rows = await tx.select({ id: table.id, name: table.name }).from(table);
    return new Map(rows.map((row) => [row.id, row.name]));
  });
}

const emptyNameMap = new Map<string, string>();

// Each transaction's split category ids, grouped by transaction (RF-69). Read in
// the caller's RLS scope so a split resolves to a category the same scope reads
// back. One round trip for every split; the category fill picks the ids of the
// transactions it exports and ignores the rest. A filtered export carries the
// list's predicates into the same round trip, so it never reads the whole
// ledger's splits to fill a handful of cells (RNF-15).
async function readSplitCategoryIds(conditions: SQL[]): Promise<Map<string, string[]>> {
  return withUserDb(async (tx) => {
    const exported =
      conditions.length === 0
        ? undefined
        : exists(
            tx
              .select({ present: sql`1` })
              .from(transactions)
              .where(
                and(
                  eq(transactions.id, transactionSplits.transactionId),
                  ...conditions,
                ),
              ),
          );

    const rows = await tx
      .select({
        transactionId: transactionSplits.transactionId,
        categoryId: transactionSplits.categoryId,
      })
      .from(transactionSplits)
      .where(exported);

    const byTransaction = new Map<string, string[]>();
    for (const row of rows) {
      const ids = byTransaction.get(row.transactionId) ?? [];
      ids.push(row.categoryId);
      byTransaction.set(row.transactionId, ids);
    }
    return byTransaction;
  });
}

const emptySplitMap = new Map<string, string[]>();

// One raw row turned into its sheet shape: a reference to its name, `placement` to
// a personal/group indicator, money left in integer cents (RNF-05), scalars as is.
function toExportRows<E extends SheetEntity>(
  entity: E,
  rows: Record<string, unknown>[],
  accountNames: Map<string, string>,
  categoryNames: Map<string, string>,
  splitCategoryIds: Map<string, string[]>,
): ExportRow<E>[] {
  const columns = sheetDescriptors[entity].columns as readonly ColumnView[];

  return rows.map((row) => {
    const cell: Record<string, CellValue> = {};

    for (const column of columns) {
      if ("synthetic" in column) {
        // The only synthetic column is a transaction's category (RF-69): the name
        // of its SINGLE split. Zero splits (a transfer) or more than one (no
        // faithful single cell) leave it blank.
        const ids = splitCategoryIds.get(row.id as string) ?? [];
        cell[column.key] = ids.length === 1 ? categoryNames.get(ids[0]) ?? null : null;
        continue;
      }

      const value = row[column.field];

      if (column.ref) {
        // A reference presents the referenced row's name; a null id (a one-sided
        // movement) or a name outside the caller's scope yields null.
        const names = column.ref.entity === "accounts" ? accountNames : categoryNames;
        cell[column.key] = value == null ? null : names.get(value as string) ?? null;
        continue;
      }

      // `placement` has no column of its own: an account naming an owner is
      // personal, one naming a group is group (RF-60), derived from `ownerUserId`.
      if (entity === "accounts" && column.field === "ownerUserId") {
        cell[column.key] = value == null ? ACCOUNT_PLACEMENTS[1] : ACCOUNT_PLACEMENTS[0];
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
  const needsSplits = requested.includes("transactions");

  // Built once so the rows and their splits are narrowed by the very same set.
  const listed = transactionConditions(input.transactionFilters);

  const [sets, accountNames, categoryNames, splitCategoryIds] = await Promise.all([
    Promise.all(
      requested.map((entity) =>
        readEntityRows(
          entity,
          input.from,
          input.to,
          // An adjustment is a ledger correction, not a movement a person made (RF-138): the
          // backup leaves it out, and the account's opening balance and the reconciliation
          // history are what carry the figure.
          entity === "transactions"
            ? [isNull(transactions.reconciliationId), ...listed]
            : [],
        ),
      ),
    ),
    needsAccounts ? readNameMap(accounts) : Promise.resolve(emptyNameMap),
    needsCategories ? readNameMap(categories) : Promise.resolve(emptyNameMap),
    needsSplits ? readSplitCategoryIds(listed) : Promise.resolve(emptySplitMap),
  ]);

  const result: ExportResult = {};
  requested.forEach((entity, index) => {
    result[entity] = toExportRows(
      entity,
      sets[index],
      accountNames,
      categoryNames,
      splitCategoryIds,
    ) as never;
  });

  return result;
}
