import "server-only";

import { createHash } from "node:crypto";
import { zipWithin } from "@repo/zip-guard";
import { getLocale, getTranslations } from "next-intl/server";
import { z } from "zod";

import {
  readImportScope,
  type ImportScope,
  type ScopedAccount,
  type ScopedCategory,
  type ScopedEntity,
} from "@/db/queries/import-preview";
import { BASE_CURRENCY, type CurrencyCode } from "@/lib/currency";
import { isCivilDate } from "@/lib/dates";
import { ActionError } from "@/lib/errors";
import { centsToPesos, maxAmountMinor, parseAmount } from "@/lib/money";
import { resolveCategoryInScope, scopeKeyOf, type ScopeKey } from "@/lib/spreadsheet/resolve-category";
import {
  labelNames,
  SHEET_ENTITIES,
  sheetDescriptors,
  signedFigureSchema,
  statementKey,
  STATEMENT_SOURCES,
  type SheetEntity,
} from "@/lib/spreadsheet/schema";
import { parseWorkbook, type ParsedRow, type ReverseSheetLabels } from "@/lib/spreadsheet/workbook";
import { importedAdjustmentSchema } from "@/lib/validation/account-reconciliation";
import { ACCOUNT_PLACEMENTS, createAccountSchema } from "@/lib/validation/account";
import { createCategorySchema } from "@/lib/validation/category";
import { createLabelSchema } from "@/lib/validation/label";
import { createBudgetSchema } from "@/lib/validation/budget";
import { debtTermsSchema } from "@/lib/validation/debt-terms";
import { createGoalSchema } from "@/lib/validation/savings-goal";
import { createMemberSchema } from "@/lib/validation/member";
import { createRecurringRuleSchema } from "@/lib/validation/recurring-rule";
import { createTransactionSchema, foreignSettlementCurrency } from "@/lib/validation/transaction";

// The soft cap the whole import obeys before any per-row work, so a runaway file
// never runs the free tier's execution budget dry (RNF-15).
const MAX_DATA_ROWS = 10_000;

// What an upload may inflate to, judged by inflating before ExcelJS reads a byte (RNF-15).
const ZIP_CAPS = { inflatedMax: 64 * 1024 * 1024, entriesMax: 200 };

// Every error the pipeline reports is a catalogue key, translated by the screen that
// shows it. The cap and the reference resolver raise these; a schema failure
// carries its own field keys.
export const TOO_MANY_ROWS = "data.import.errors.tooManyRows";
// The bytes are not a workbook that inflates within the caps below.
export const NOT_A_WORKBOOK = "data.import.errors.notWorkbook";
const UNKNOWN_REFERENCE = "data.import.errors.unknownReference";
const AMBIGUOUS_REFERENCE = "data.import.errors.ambiguousReference";
// The name exists, but only in the scope the row's account is not in (RF-140).
const CATEGORY_OUT_OF_SCOPE = "data.import.errors.categoryOutOfScope";
const INVALID_CELL = "data.import.errors.invalidCell";
// A budget's or a goal's name resolves, but only outside the place its row names (RF-142).
const OUT_OF_PLACE = "data.import.errors.outOfPlace";
// The row names the fund as its place, and the person importing has none.
const NO_FUND = "data.import.errors.noFund";
// A second row in the file for the same account's terms or the same account's cut-off.
const REPEATED_ROW = "data.import.errors.repeatedRow";
// A category resolves fine and still refuses the row: its kind must match the
// movement's own direction (RF-27), the same rule `assert_split_matches_transaction`
// enforces at write time — checked here so a bad row never reaches that trigger.
const CATEGORY_KIND_MISMATCH = "data.import.errors.categoryKindMismatch";
// Shared with the webhook and the commit's own gate (RF-121), so it lives outside
// this module's `data.import.errors` namespace: the same key names the same reason
// wherever a pesos-only path meets an account outside BASE_CURRENCY.
const FOREIGN_CURRENCY_UNSUPPORTED = "errors.foreignCurrencyUnsupported";
const ADJUSTMENT_ONE_ACCOUNT = "data.import.errors.adjustmentOneAccount";
// The row names a currency its account does not settle in and brings no amount in the account's own,
// so it refuses instead of re-denominating (RF-50, RF-121, RF-122).
const ROW_CURRENCY_MISMATCH = "transactions.errors.currencyMismatch";
// A row in its account's own currency names a second amount the movement does not have (RF-122).
const COUNTER_AMOUNT_FORBIDDEN = "transactions.errors.counterAmountForbidden";
const COUNTER_AMOUNT_TOO_LARGE = "transactions.errors.amountTooLarge";
// A file row for an existing account that names another settlement currency than the one it has.
const ACCOUNT_CURRENCY_CHANGE = "accounts.errors.currencyLocked";
// The row is dated before the opening day of an account it names (RF-162), the rule
// `transactions_after_opening` holds at write time.
const BEFORE_OPENING = "data.import.errors.beforeOpening";

// A catalogue key is a dotted identifier with no spaces; a raw Zod default is an
// English sentence. The light guard's number/enum/date fields carry no custom key,
// so a mistyped cell surfaces Zod's default — mapped to a key here so no English
// string ever reaches the preview.
const CATALOGUE_KEY = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/;

// A stable, private namespace for the placeholder id a file-new reference target
// resolves to; the preview never writes, so a placeholder purely satisfies the
// authoritative schema's `z.uuid()` and a later commit rebuilds the same map.
const PLACEHOLDER_NAMESPACE = "finances-app/import";

// What a budget or a goal carries beside its form's fields: the place it lands in and whether
// it lands archived (RF-120).
const restoredFields = { placement: z.enum(ACCOUNT_PLACEMENTS), archived: z.boolean() };

// A contribution restored with its day and the movement it earmarks, by that movement's key.
const restoredContributionSchema = z.object({
  goalId: z.uuid(),
  amount: z.string(),
  contributedOn: z.string().refine(isCivilDate),
  movement: z.string().nullable(),
});

// A closed statement as the ledger holds it (RF-129): its figures signed, its days in order.
const restoredStatementSchema = z
  .object({
    accountId: z.uuid(),
    periodStart: z.string().refine(isCivilDate),
    cutOffDate: z.string().refine(isCivilDate),
    paymentDueDate: z.string().refine(isCivilDate).nullable(),
    openingBalance: signedFigureSchema.nullable(),
    closingBalance: signedFigureSchema,
    credits: signedFigureSchema.nullable(),
    debits: signedFigureSchema.nullable(),
    minimumPayment: signedFigureSchema.nullable(),
    interestCharged: signedFigureSchema.nullable(),
    feesCharged: signedFigureSchema.nullable(),
    source: z.enum(STATEMENT_SOURCES),
  })
  .refine((row) => row.periodStart <= row.cutOffDate, { path: ["periodStart"] })
  .refine((row) => row.paymentDueDate === null || row.paymentDueDate >= row.cutOffDate, { path: ["paymentDueDate"] });

// The authoritative id-shaped schema each entity re-runs after name→id resolution,
// the same one its form uses (RNF-10).
const createSchemas = {
  accounts: createAccountSchema,
  members: createMemberSchema,
  categories: createCategorySchema,
  labels: createLabelSchema,
  recurringRules: createRecurringRuleSchema,
  transactions: createTransactionSchema,
  budgets: createBudgetSchema.extend(restoredFields),
  goals: createGoalSchema.omit({ initialContribution: true }).extend(restoredFields),
  goalContributions: restoredContributionSchema,
  debts: debtTermsSchema,
  statements: restoredStatementSchema,
} as const;

// A raw parsed record holds a name, a scalar, integer cents or nothing.
export type RawRow = Record<string, string | number | boolean | null>;

// One problem on one row, traced back to the cell it came from (RF-51). `column`
// is the sheet's own column key (the screen translates it) — null for the rare
// check that spans more than one cell, which names no single column honestly.
// `value` is the cell exactly as the person typed it, read back through the
// money boundary when the column is one; null wherever `column` is.
export type RowFieldError = {
  key: string;
  column: string | null;
  value: string | null;
};

// One row after the three gates: its position, its new-vs-update classification, the
// errors it collected, and — only when it passed clean — the resolved, id-shaped and
// schema-validated object a later commit writes. `object` is null for an errored row.
// `externalRef` and `placeholderId` ride alongside because the authoritative schema
// strips both from `object`, yet the commit needs the raw stable key to write it and
// key an update (RF-52), and the placeholder a NEW account, category, label or goal was assigned so
// a reference to it remaps to its REAL inserted id (RF-51), never the placeholder.
// `index` is the row's array position — 0-based, stable across preview and commit
// only because both re-parse the SAME file: it seeds `placeholderFor`, never a
// person's eyes. `sheetRow` is the row number that same line carries in the
// spreadsheet (RF-51), the one a person sees opening the file in Excel — a blank
// row skipped upstream pulls the two apart, so neither substitutes for the other.
export type ResolvedRow = {
  index: number;
  sheetRow: number;
  status: "new" | "update";
  errors: RowFieldError[];
  object: unknown | null;
  // The row's raw stable key, null when the file left it blank (a trigger backfills it).
  externalRef: string | null;
  // The deterministic placeholder a file-new account, category, label or goal is referenced by;
  // null for every other entity and for an update, which reuses the existing real id.
  placeholderId: string | null;
};

export type ImportEntityResult = {
  entity: SheetEntity;
  rows: ResolvedRow[];
};

// What both the preview and a future commit consume: every entity's resolved rows and
// the run's tallies. The preview strips `object`; the commit writes the passing rows.
export type ImportResult = {
  perEntity: ImportEntityResult[];
  totals: { new: number; update: number; error: number };
};

// The effective post-import set a reference resolves against: existing rows unioned
// with the file's own account/category sheet rows. Two maps, name → the ids of the
// distinct effective entities carrying that name.
// `accountCurrencies` rides alongside the name maps: an existing account's settlement
// currency (RF-121), keyed by its real id so a resolved reference checks it straight
// off. A file-new account (a placeholder) is never in it — `commitAccounts` writes it
// none, so the column default (BASE_CURRENCY) already holds — so an absent id passes.
export type EffectiveRefs = {
  accounts: Map<string, string[]>;
  categories: Map<string, string[]>;
  labels: Map<string, string[]>;
  goals: Map<string, string[]>;
  // Every movement key a contribution may name: the fund's and the file's (RF-87).
  movementKeys: Set<string>;
  // Where a row whose placement is personal, or group, lands; null for a fund the caller lacks.
  places: { personal: ScopeKey; group: ScopeKey | null };
  accountCurrencies: Map<string, string>;
  // An existing account's settlement currency by its stable key, for the file row that updates it.
  accountCurrencyByRef: Map<string, string>;
  // A resolved category's kind, by its effective id, existing rows unioned with the
  // file's own new categories — never trusted from the file's `kind` cell alone,
  // since a stray typo there is caught by the category row's own schema, not here.
  categoryKinds: Map<string, string>;
  // The scope each effective account and category lands in, by the same ids the name
  // maps hold. A file-new fund account of a caller with no fund has none (null).
  accountScopes: Map<string, ScopeKey | null>;
  categoryScopes: Map<string, ScopeKey>;
  labelScopes: Map<string, ScopeKey | null>;
  // Each effective account's opening day, by the same ids the name map holds.
  accountOpenings: Map<string, string>;
};

// The money column keys of each entity, so the light guard sees a peso string where
// the raw record carries integer cents.
const moneyKeysByEntity = Object.fromEntries(
  SHEET_ENTITIES.map((entity) => {
    const columns = sheetDescriptors[entity].columns as readonly {
      key: string;
      money?: unknown;
    }[];
    return [entity, new Set(columns.filter((column) => column.money != null).map((c) => c.key))];
  }),
) as Record<SheetEntity, Set<string>>;

// A trimmed string cell, or "" for anything else — the shape the effective-set and
// classification code reads a raw name or key as.
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// A deterministic v5-style uuid from a seed, so a file-new reference target resolves
// to the same placeholder every run: a fixed-namespace SHA-1, versioned and variant-
// tagged, formatted as a uuid the authoritative schema's `z.uuid()` accepts.
function placeholderUuid(seed: string): string {
  const bytes = createHash("sha1").update(`${PLACEHOLDER_NAMESPACE}:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// The one seed both the effective-set builder and a row's exposed `placeholderId`
// derive from, so a reference and its target resolve to the SAME placeholder: a stable
// key seeds by that key, a blank one by the file position — never a real database id.
function placeholderFor(seedPrefix: string, ref: string, rowIndex: number): string {
  const seed = ref.length > 0 ? `${seedPrefix}:ref:${ref}` : `${seedPrefix}:new:${rowIndex}`;
  return placeholderUuid(seed);
}

// The effective post-import name→ids map for one referenced entity: the caller's
// existing rows plus the file's own rows for that entity, deduped by stable key. A
// file row whose key matches an existing row is the SAME entity — it adds no
// candidate but may rename it; a file row with a new or blank key is a NEW entity
// with a deterministic placeholder id. Distinct entities that share a name both land
// under it, so the resolver still calls that name ambiguous.
function buildEffectiveMap(
  existing: ScopedEntity[],
  fileRows: RawRow[],
  seedPrefix: string,
): Map<string, string[]> {
  const entities: { id: string; name: string }[] = existing.map((row) => ({
    id: row.id,
    name: row.name,
  }));

  const indexByRef = new Map<string, number>();
  existing.forEach((row, index) => {
    if (row.externalRef != null) indexByRef.set(row.externalRef, index);
  });

  fileRows.forEach((raw, rowIndex) => {
    const ref = text(raw.externalRef);
    const name = text(raw.name);
    const existingIndex = ref.length > 0 ? indexByRef.get(ref) : undefined;

    if (existingIndex !== undefined) {
      // Same entity as an existing row (an update); a rename overrides its name.
      if (name.length > 0) entities[existingIndex].name = name;
      return;
    }

    entities.push({ id: placeholderFor(seedPrefix, ref, rowIndex), name });
  });

  const map = new Map<string, string[]>();
  for (const entity of entities) {
    if (entity.name.length === 0) continue;
    const ids = map.get(entity.name) ?? [];
    ids.push(entity.id);
    map.set(entity.name, ids);
  }
  return map;
}

// Every account's settlement currency by its effective id: an existing account keeps the one it has
// (a file row never changes it), a file-new account takes its own cell, blank meaning the base one.
// Same ids `buildEffectiveMap` mints, so a resolved reference reads the entity it resolved to.
function buildAccountCurrencies(
  existing: ScopedAccount[],
  fileRows: RawRow[],
): Map<string, string> {
  const currencyById = new Map(existing.map((row) => [row.id, row.settlementCurrency]));
  const existingRefs = new Set(existing.flatMap((row) => (row.externalRef != null ? [row.externalRef] : [])));

  fileRows.forEach((raw, rowIndex) => {
    const ref = text(raw.externalRef);
    if (ref.length > 0 && existingRefs.has(ref)) return;
    const cell = text(raw.settlementCurrency);
    currencyById.set(placeholderFor("accounts", ref, rowIndex), cell.length > 0 ? cell : BASE_CURRENCY);
  });

  return currencyById;
}

// Every account's opening day by its effective id, as the commit leaves it before any movement lands:
// a file row writes its own `balanceOn` over an existing account's and gives a file-new one its day.
// A cell that is no civil day is left out; that account row refuses itself.
function buildAccountOpenings(existing: ScopedAccount[], fileRows: RawRow[]): Map<string, string> {
  const openingById = new Map(existing.map((row) => [row.id, row.initialBalanceOn]));
  const idByRef = new Map(existing.flatMap((row) => (row.externalRef != null ? [[row.externalRef, row.id] as const] : [])));

  fileRows.forEach((raw, rowIndex) => {
    const ref = text(raw.externalRef);
    const day = text(raw.balanceOn);
    if (!isCivilDate(day)) return;
    const existingId = ref.length > 0 ? idByRef.get(ref) : undefined;
    openingById.set(existingId ?? placeholderFor("accounts", ref, rowIndex), day);
  });

  return openingById;
}

// The effective post-import id→kind map for categories, over the same ids
// `buildEffectiveMap` mints for the name map above, so a resolved reference reads
// the kind of the very entity it resolved to. An existing category never changes
// kind on an update (the commit never writes one), so a matched file row keeps the
// existing kind; a file-new category carries whatever kind its own cell names,
// right or wrong — a wrong one fails that row's own schema, never this lookup.
function buildCategoryKinds(existing: ScopedCategory[], fileRows: RawRow[]): Map<string, string> {
  const kindById = new Map(existing.map((row) => [row.id, row.kind]));

  const indexByRef = new Map<string, ScopedCategory>();
  existing.forEach((row) => {
    if (row.externalRef != null) indexByRef.set(row.externalRef, row);
  });

  fileRows.forEach((raw, rowIndex) => {
    const ref = text(raw.externalRef);
    const matched = ref.length > 0 ? indexByRef.get(ref) : undefined;
    if (matched !== undefined) return;

    kindById.set(placeholderFor("categories", ref, rowIndex), text(raw.kind));
  });

  return kindById;
}

// The effective id→scope map for one entity, over the same ids `buildEffectiveMap`
// mints: an existing row, renamed by the file or not, keeps the scope it has; a
// file-new row takes the scope the commit will write it in.
function buildScopes<S extends ScopeKey | null>(
  existing: ScopedEntity[],
  fileRows: RawRow[],
  seedPrefix: string,
  scopeOfNew: (raw: RawRow) => S,
): Map<string, S> {
  const scopeById = new Map<string, S>(existing.map((row) => [row.id, scopeKeyOf(row) as S]));
  const existingRefs = new Set(existing.flatMap((row) => (row.externalRef != null ? [row.externalRef] : [])));

  fileRows.forEach((raw, rowIndex) => {
    const ref = text(raw.externalRef);
    if (ref.length > 0 && existingRefs.has(ref)) return;
    scopeById.set(placeholderFor(seedPrefix, ref, rowIndex), scopeOfNew(raw));
  });

  return scopeById;
}

// The raw record turned name-shaped for the descriptor's light guard: a money cell
// crosses back from integer cents to a peso string, so the same peso-string schema
// the form uses validates it (RNF-10); a blank money cell reads as empty, which the
// schema reports as required rather than mistyped.
function toNameShaped(entity: SheetEntity, raw: RawRow): Record<string, unknown> {
  const moneyKeys = moneyKeysByEntity[entity];
  const shaped: Record<string, unknown> = { ...raw };
  for (const key of moneyKeys) {
    const value = raw[key];
    shaped[key] =
      typeof value === "number"
        ? String(centsToPesos(value))
        : typeof value === "string"
          ? value
          : "";
  }
  // A transfer carries no category (RF-20): the cell is dropped before the light guard, so
  // whatever a backup left in it, even a name past the guard's bound, never refuses the row.
  if (entity === "transactions" && text(raw.fromAccount).length > 0 && text(raw.toAccount).length > 0) {
    shaped.category = null;
  }
  return shaped;
}

// A row's stable key decides new vs update (RF-52): an `external_ref` already in the
// caller's EXISTING scope updates, one absent — or blank, a fresh template row — is
// new. Classified from the raw key so a row that fails validation still lands in a
// bucket; the effective set governs resolution, never classification.
function classify(entity: SheetEntity, raw: RawRow, existingRefs: Set<string>): "new" | "update" {
  const ref = text(raw.externalRef);
  return ref.length > 0 && existingRefs.has(ref) ? "update" : "new";
}

// The cell exactly as the person typed it, read back for display (RF-51). A
// malformed money cell survived `parseWorkbook` as its own text — never
// coerced, so it reads back unchanged; a well-formed one already crossed to
// cents there, so it crosses back to pesos here. Every other column reads its
// raw scalar as a plain string; a blank cell reads as none.
function rawCellValue(entity: SheetEntity, raw: RawRow, column: string): string | null {
  const value = raw[column];
  if (value === null || value === undefined) return null;
  if (moneyKeysByEntity[entity].has(column) && typeof value === "number") {
    return String(centsToPesos(value));
  }
  return String(value);
}

// Gate 2 (the authoritative `createSchemas[entity]`) reshapes three entities'
// guard output into an id-shaped object first, so its own field names diverge
// from the sheet's column keys; this walks one back to the other. Accounts and
// members carry no reference and reshape into nothing (`resolveAndShape`
// returns the guard's own data unchanged), so their gate-2 field names already
// equal their column keys and need no entry here.
const GATE2_COLUMN_BY_FIELD: Partial<Record<SheetEntity, Record<string, string>>> = {
  categories: { name: "name", kind: "kind", parentId: "parent", color: "color" },
  recurringRules: {
    fromAccountId: "fromAccount",
    toAccountId: "toAccount",
    amount: "amount",
    categoryId: "category",
    description: "description",
    frequency: "frequency",
    intervalN: "intervalN",
    dayOfMonth: "dayOfMonth",
    nextRunOn: "nextRunOn",
    endsOn: "endsOn",
  },
  transactions: {
    fromAccountId: "fromAccount",
    toAccountId: "toAccount",
    amount: "amount",
    occurredAt: "occurredAt",
    description: "description",
    externalRef: "externalRef",
    labelIds: "labels",
  },
  budgets: { categoryId: "category", accountId: "account", labelId: "label" },
  goals: { accountId: "account" },
  goalContributions: { goalId: "goal" },
  debts: { accountId: "account", statementCutOffDay: "cutOffDay", paymentDueDay: "dueDay" },
  statements: { accountId: "account" },
};

// The column a Zod issue's path names, at whichever gate raised it (RF-51). Gate
// 1 (`rowSchema`) shares its field names with the sheet's own columns, so a
// path segment already is one. A transaction's split carries its own amount
// and category (RF-69) — the sheet holds one flat cell for each, so every path
// under `splits` folds back to the cell it came from, `amount` included for
// the sum-mismatch and required/forbidden checks, which a single-split import
// row still keeps there. A path this map does not know is a check that spans
// more than one cell: it draws no column, honestly, rather than guess one.
function columnForPath(
  entity: SheetEntity,
  gate: "row" | "authoritative",
  path: readonly PropertyKey[],
): string | null {
  const columnKeys = new Set(
    (sheetDescriptors[entity].columns as readonly { key: string }[]).map((c) => c.key),
  );
  const field = String(path[0] ?? "");

  if (gate === "row") return columnKeys.has(field) ? field : null;

  if (entity === "transactions" && field === "splits") {
    if (path[2] === "categoryId") return "category";
    return "amount";
  }

  const mapped = GATE2_COLUMN_BY_FIELD[entity]?.[field];
  if (mapped !== undefined) return mapped;
  return columnKeys.has(field) ? field : null;
}

// A distinct, ordered list of the errors a Zod failure raised, each traced back
// to its column and its raw cell (RF-51). A field with a custom key passes its
// key through; a default English message from a number, enum or date field
// maps to the generic invalid-cell key. Deduplicated by key and column
// together, not by key alone — two different cells failing the same generic
// check are two lines, not one.
function issueErrors(
  entity: SheetEntity,
  gate: "row" | "authoritative",
  raw: RawRow,
  error: z.ZodError,
): RowFieldError[] {
  const seen = new Set<string>();
  const out: RowFieldError[] = [];

  for (const issue of error.issues) {
    const key = CATALOGUE_KEY.test(issue.message) ? issue.message : INVALID_CELL;
    const column = columnForPath(entity, gate, issue.path);
    const dedupeKey = `${key} ${column ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ key, column, value: column ? rawCellValue(entity, raw, column) : null });
  }

  return out;
}

// One reference name to an id in the effective set: no match is unknown, more than
// one distinct entity is ambiguous — both per-row, never a whole-file abort (the
// decided behaviour).
function resolveOne(name: string, map: Map<string, string[]>): { id?: string; error?: string } {
  const ids = map.get(name) ?? [];
  if (ids.length === 0) return { error: UNKNOWN_REFERENCE };
  if (ids.length > 1) return { error: AMBIGUOUS_REFERENCE };
  return { id: ids[0] };
}

// A resolved account reference read against its settlement currency (RF-121): the
// row's `amount` is still booked as BASE_CURRENCY downstream, true only of an
// account settling in it. Silent on a null id (no reference named) and on one the
// map does not carry (unresolved, or a file-new account, always base by default) —
// this only ever raises the ONE reason resolution itself does not already cover.
function checkBaseCurrency(
  entity: SheetEntity,
  raw: RawRow,
  accountId: string | null,
  column: string,
  currencies: Map<string, string>,
  errors: RowFieldError[],
): void {
  const currency = accountId !== null ? currencies.get(accountId) : undefined;
  if (currency !== undefined && currency !== BASE_CURRENCY) {
    errors.push({
      key: FOREIGN_CURRENCY_UNSUPPORTED,
      column,
      value: rawCellValue(entity, raw, column),
    });
  }
}

// A transaction row's `currency` cell read against both accounts it names (RF-50, RF-121), by the
// rule `transactions_verify_currency` holds at write time. A blank cell is a sheet from before the
// column and passes only on base-currency accounts, as every such sheet was. A named one may differ
// from one side's settlement currency when `counterAmount` carries that side's amount (RF-122) —
// never on an adjustment, which is one account's own gap. Returns the second amount in that
// currency's minor unit, or null when the row has none or is refused.
function checkRowCurrency(
  entity: SheetEntity,
  raw: RawRow,
  row: { currency?: string | null; counterAmount?: string | null; adjustment?: true | null },
  fromAccountId: string | null,
  toAccountId: string | null,
  currencies: Map<string, string>,
  errors: RowFieldError[],
): number | null {
  const settlementOf = (id: string | null) =>
    ((id !== null ? currencies.get(id) : undefined) ?? null) as CurrencyCode | null;
  const settlement = { from: settlementOf(fromAccountId), to: settlementOf(toAccountId) };
  const counter = row.counterAmount ?? null;
  const mismatch = () =>
    errors.push({ key: ROW_CURRENCY_MISMATCH, column: "currency", value: rawCellValue(entity, raw, "currency") });

  if (row.currency == null) {
    if ([settlement.from, settlement.to].some((c) => c !== null && c !== BASE_CURRENCY)) {
      errors.push({ key: FOREIGN_CURRENCY_UNSUPPORTED, column: "currency", value: null });
      return null;
    }
  } else if (
    settlement.from !== null &&
    settlement.to !== null &&
    settlement.from !== settlement.to &&
    row.currency !== settlement.from &&
    row.currency !== settlement.to
  ) {
    mismatch();
    return null;
  }

  const foreign = foreignSettlementCurrency((row.currency ?? BASE_CURRENCY) as CurrencyCode, settlement);
  if (foreign === null) {
    if (counter !== null) {
      errors.push({ key: COUNTER_AMOUNT_FORBIDDEN, column: "counterAmount", value: rawCellValue(entity, raw, "counterAmount") });
    }
    return null;
  }

  if (counter === null || row.adjustment === true) {
    mismatch();
    return null;
  }

  // The light guard read the cell in some currency; the one it is in is known only now.
  const minor = parseAmount(counter);
  if (minor === null || minor > maxAmountMinor(foreign)) {
    errors.push({ key: COUNTER_AMOUNT_TOO_LARGE, column: "counterAmount", value: rawCellValue(entity, raw, "counterAmount") });
    return null;
  }
  return minor;
}

// The guard's output (names, all references still names) turned id-shaped for the
// authoritative schema, gathering a per-row error for every reference that does not
// resolve to exactly one entity in the effective set. The object is only meaningful
// when `errors` is empty; the caller stops before validating otherwise. `raw` never
// feeds the object a reference resolves to — only the error a failed one carries,
// so its cell reads back as what the person typed (RF-51).
function resolveAndShape(
  entity: SheetEntity,
  data: Record<string, unknown>,
  refs: EffectiveRefs,
  raw: RawRow,
): { object: unknown; errors: RowFieldError[] } {
  const errors: RowFieldError[] = [];

  const resolveInto = (
    name: unknown,
    map: Map<string, string[]>,
    column: string,
  ): string | null => {
    if (name == null) return null;
    const resolved = resolveOne(name as string, map);
    if (resolved.error) {
      errors.push({ key: resolved.error, column, value: rawCellValue(entity, raw, column) });
      return null;
    }
    return resolved.id ?? null;
  };

  // A movement's or a rule's category, picked among the same-named ones by the scope
  // of the account it books on: the source for an expense, the destination for an
  // income. Any other shape, or an account that did not resolve, leaves the name alone.
  const resolveCategory = (
    name: unknown,
    fromAccountId: string | null,
    toAccountId: string | null,
  ): string | null => {
    if (name == null) return null;
    const accountId =
      data.fromAccount != null && data.toAccount == null
        ? fromAccountId
        : data.fromAccount == null && data.toAccount != null
          ? toAccountId
          : null;
    const accountScope = accountId !== null ? (refs.accountScopes.get(accountId) ?? null) : null;
    const resolved = resolveCategoryInScope(refs.categories.get(name as string) ?? [], accountScope, refs.categoryScopes);
    if ("id" in resolved) return resolved.id;
    const key = {
      unknown: UNKNOWN_REFERENCE,
      ambiguous: AMBIGUOUS_REFERENCE,
      outOfScope: CATEGORY_OUT_OF_SCOPE,
    }[resolved.error];
    errors.push({ key, column: "category", value: rawCellValue(entity, raw, "category") });
    return null;
  };

  // A budget's or a goal's reference, picked among the same-named rows by the place the row
  // names: the category, account or label must share it, as the scope trigger demands.
  const resolveInPlace = (
    name: unknown,
    map: Map<string, string[]>,
    scopes: ReadonlyMap<string, ScopeKey | null>,
    place: ScopeKey | null,
    column: string,
  ): string | null => {
    if (name == null || place === null) return null;
    const resolved = resolveCategoryInScope(map.get(name as string) ?? [], place, scopes as ReadonlyMap<string, ScopeKey>);
    if ("id" in resolved) return resolved.id;
    const key = { unknown: UNKNOWN_REFERENCE, ambiguous: AMBIGUOUS_REFERENCE, outOfScope: OUT_OF_PLACE }[resolved.error];
    errors.push({ key, column, value: rawCellValue(entity, raw, column) });
    return null;
  };

  const placeOf = (placement: unknown): ScopeKey | null => {
    const place = placement === "group" ? refs.places.group : refs.places.personal;
    if (place === null) errors.push({ key: NO_FUND, column: "placement", value: rawCellValue(entity, raw, "placement") });
    return place;
  };

  switch (entity) {
    case "budgets": {
      const place = placeOf(data.placement);
      return {
        object: {
          categoryId: resolveInPlace(data.category, refs.categories, refs.categoryScopes, place, "category"),
          accountId: resolveInPlace(data.account, refs.accounts, refs.accountScopes, place, "account"),
          labelId: resolveInPlace(data.label, refs.labels, refs.labelScopes, place, "label"),
          period: data.period,
          limit: data.limit,
          thresholdPct: data.thresholdPct,
          name: data.name ?? null,
          placement: data.placement,
          archived: data.archived === true,
        },
        errors,
      };
    }

    case "goals": {
      const place = placeOf(data.placement);
      return {
        object: {
          name: data.name,
          targetAmount: data.targetAmount,
          targetDate: data.targetDate ?? null,
          accountId: resolveInPlace(data.account, refs.accounts, refs.accountScopes, place, "account"),
          placement: data.placement,
          archived: data.archived === true,
        },
        errors,
      };
    }

    case "goalContributions": {
      const movement = (data.movement ?? null) as string | null;
      if (movement !== null && !refs.movementKeys.has(movement)) {
        errors.push({ key: UNKNOWN_REFERENCE, column: "movement", value: rawCellValue(entity, raw, "movement") });
      }
      return {
        object: {
          goalId: resolveInto(data.goal, refs.goals, "goal"),
          amount: data.amount,
          contributedOn: data.contributedOn,
          movement,
        },
        errors,
      };
    }

    case "debts":
      return {
        object: {
          accountId: resolveInto(data.account, refs.accounts, "account"),
          debtKind: data.debtKind,
          annualRate: data.annualRate,
          minimumPayment: data.minimumPayment ?? null,
          minimumPaymentPct: data.minimumPaymentPct ?? null,
          creditLimit: data.creditLimit ?? null,
          statementCutOffDay: data.cutOffDay ?? null,
          paymentDueDay: data.dueDay ?? null,
          aval: data.aval ?? null,
        },
        errors,
      };

    case "statements":
      return {
        object: {
          accountId: resolveInto(data.account, refs.accounts, "account"),
          periodStart: data.periodStart,
          cutOffDate: data.cutOffDate,
          paymentDueDate: data.paymentDueDate ?? null,
          openingBalance: data.openingBalance ?? null,
          closingBalance: data.closingBalance,
          credits: data.credits ?? null,
          debits: data.debits ?? null,
          minimumPayment: data.minimumPayment ?? null,
          interestCharged: data.interestCharged ?? null,
          feesCharged: data.feesCharged ?? null,
          source: data.source,
        },
        errors,
      };

    case "accounts": {
      const ref = text(raw.externalRef);
      const existing = ref.length > 0 ? refs.accountCurrencyByRef.get(ref) : undefined;
      if (existing !== undefined && existing !== data.settlementCurrency) {
        errors.push({
          key: ACCOUNT_CURRENCY_CHANGE,
          column: "settlementCurrency",
          value: rawCellValue(entity, raw, "settlementCurrency"),
        });
      }
      return { object: data, errors };
    }

    case "members":
      // No cross-entity reference: the guard's output is already id-shaped.
      return { object: data, errors };

    case "labels": {
      const placement = data.placement ?? (refs.places.group !== null ? "group" : "personal");
      placeOf(placement);
      return { object: { name: data.name, color: data.color, placement }, errors };
    }

    case "categories": {
      const parentId = resolveInto(data.parent, refs.categories, "parent");
      return {
        object: { name: data.name, kind: data.kind, parentId, color: data.color },
        errors,
      };
    }

    case "recurringRules": {
      const fromAccountId = resolveInto(data.fromAccount, refs.accounts, "fromAccount");
      const toAccountId = resolveInto(data.toAccount, refs.accounts, "toAccount");
      const categoryId = resolveCategory(data.category, fromAccountId, toAccountId);
      checkBaseCurrency(entity, raw, fromAccountId, "fromAccount", refs.accountCurrencies, errors);
      checkBaseCurrency(entity, raw, toAccountId, "toAccount", refs.accountCurrencies, errors);
      return {
        object: {
          fromAccountId,
          toAccountId,
          amount: data.amount,
          categoryId,
          description: data.description,
          frequency: data.frequency,
          intervalN: data.intervalN,
          dayOfMonth: data.dayOfMonth,
          nextRunOn: data.nextRunOn,
          endsOn: data.endsOn,
        },
        errors,
      };
    }

    case "transactions": {
      const fromAccountId = resolveInto(data.fromAccount, refs.accounts, "fromAccount");
      const toAccountId = resolveInto(data.toAccount, refs.accounts, "toAccount");
      // Civil days compare as strings. One line for the row, whichever leg opens later.
      const day = data.occurredAt as string;
      const openings = [fromAccountId, toAccountId].flatMap((id) => (id !== null ? [refs.accountOpenings.get(id)] : []));
      if (openings.some((opening) => opening !== undefined && day < opening)) {
        errors.push({ key: BEFORE_OPENING, column: "occurredAt", value: rawCellValue(entity, raw, "occurredAt") });
      }
      const rowCurrency = data.currency as string | null | undefined;
      const counterAmount = (data.counterAmount ?? null) as string | null;
      const counterAmountCents = checkRowCurrency(
        entity,
        raw,
        { currency: rowCurrency, counterAmount, adjustment: data.adjustment as true | null | undefined },
        fromAccountId,
        toAccountId,
        refs.accountCurrencies,
        errors,
      );

      // An adjustment is one account's gap: one leg, no category, never a split (RF-138).
      if (data.adjustment === true) {
        if ((data.fromAccount == null) === (data.toAccount == null)) {
          errors.push({ key: ADJUSTMENT_ONE_ACCOUNT, column: "adjustment", value: "true" });
        }
        return {
          object: {
            adjustment: true,
            accountId: fromAccountId ?? toAccountId,
            direction: data.fromAccount == null ? "up" : "down",
            amount: data.amount,
            occurredAt: data.occurredAt,
          },
          errors,
        };
      }

      // The kind follows the account pair: both names present is a transfer, which
      // carries no category and no splits (RF-20/RF-69). An income or expense builds
      // a single split for the row's full amount, so the split-sum rule holds.
      const isTransfer = data.fromAccount != null && data.toAccount != null;
      const categoryId = isTransfer
        ? null
        : resolveCategory(data.category, fromAccountId, toAccountId);

      // A category that resolves fine can still be the wrong kind for this movement's
      // direction (RF-27): income when only a destination is named, expense when only
      // a source is (mirrors the `kind` the transactions table itself generates).
      // Skipped when both accounts are absent — `requireAnAccount` already refuses
      // that row on its own terms.
      if (!isTransfer && categoryId !== null && (data.fromAccount != null || data.toAccount != null)) {
        const expectedKind = data.fromAccount == null ? "income" : "expense";
        const actualKind = refs.categoryKinds.get(categoryId);
        if (actualKind !== undefined && actualKind !== expectedKind) {
          errors.push({
            key: CATEGORY_KIND_MISMATCH,
            column: "category",
            value: rawCellValue(entity, raw, "category"),
          });
        }
      }

      const splits = isTransfer ? [] : [{ categoryId, amount: data.amount }];
      // A movement's labels share its scope, as the trigger on `transaction_labels` demands.
      const movementAccount = fromAccountId ?? toAccountId;
      const movementScope = movementAccount !== null ? (refs.accountScopes.get(movementAccount) ?? null) : null;
      const labelIds = [
        ...new Set(
          labelNames(data.labels as string | null | undefined).flatMap(
            (name) => resolveInPlace(name, refs.labels, refs.labelScopes, movementScope, "labels") ?? [],
          ),
        ),
      ];

      return {
        object: {
          fromAccountId,
          toAccountId,
          amount: data.amount,
          // Amounts and splits are read in the row's own currency; blank keeps the base one.
          ...(rowCurrency != null ? { currency: rowCurrency } : {}),
          // A row in its account's own currency stays as an old sheet's did; a foreign one carries
          // its account's amount and whether it is still an estimate (RF-122, RF-123). An estimate
          // with no amount goes through too, so the authoritative schema refuses it in its words.
          ...(counterAmountCents !== null
            ? { counterAmount, counterAmountCents, counterIsEstimate: data.counterIsEstimate === true }
            : data.counterIsEstimate === true
              ? { counterIsEstimate: true }
              : {}),
          ...(data.forHousehold ? { forHousehold: true } : {}),
          occurredAt: data.occurredAt,
          description: data.description,
          externalRef: data.externalRef,
          splits,
          labelIds,
        },
        errors,
      };
    }
  }
}

// Debts and statements have no key of their own: what they belong to keys them, an account's
// terms (RF-78) or an account's cut-off (RF-129).
function ownedKey(entity: SheetEntity, object: unknown): string | null {
  if (entity === "debts") return (object as { accountId: string }).accountId;
  if (entity === "statements") {
    const { accountId, cutOffDate } = object as { accountId: string; cutOffDate: string };
    return statementKey(accountId, cutOffDate);
  }
  return null;
}

/**
 * Refuses the second row a file holds for one account's terms or one account's cut-off: the
 * table keeps one, and a commit handed two would fail on its key with no row named.
 */
export function refuseRepeated(entity: SheetEntity, rows: ResolvedRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.object === null ? null : ownedKey(entity, row.object);
    if (key === null) continue;
    if (seen.has(key)) {
      row.errors = [{ key: REPEATED_ROW, column: "account", value: null }];
      row.object = null;
    }
    seen.add(key);
  }
}

// One row through the three ordered gates (RF-51): the light guard, name→id
// resolution against the effective set, then the authoritative schema. Errors are
// collected, never thrown; each gate feeds the next only on success, and the row is
// classified regardless. The resolved object rides along for a later commit.
export function processRow(
  entity: SheetEntity,
  raw: RawRow,
  index: number,
  sheetRow: number,
  refs: EffectiveRefs,
  existingRefs: Set<string>,
): ResolvedRow {
  const status = classify(entity, raw, existingRefs);

  // The raw stable key and, for a NEW account, category, label or goal, the placeholder a reference
  // to it resolves to — both carried whatever the gates decide, so an errored row still
  // reports its key and the commit never recomputes either.
  const ref = text(raw.externalRef);
  const externalRef = ref.length > 0 ? ref : null;
  const placeholderId =
    (entity === "accounts" || entity === "categories" || entity === "labels" || entity === "goals") && status === "new"
      ? placeholderFor(entity, ref, index)
      : null;
  const carried = { index, sheetRow, status, externalRef, placeholderId };

  const guarded = sheetDescriptors[entity].rowSchema.safeParse(toNameShaped(entity, raw));
  if (!guarded.success) {
    return { ...carried, errors: issueErrors(entity, "row", raw, guarded.error), object: null };
  }

  const resolved = resolveAndShape(entity, guarded.data as Record<string, unknown>, refs, raw);
  if (resolved.errors.length > 0) return { ...carried, errors: resolved.errors, object: null };

  const isAdjustment =
    entity === "transactions" && (guarded.data as { adjustment?: unknown }).adjustment === true;
  const checked = (isAdjustment ? importedAdjustmentSchema : createSchemas[entity]).safeParse(
    resolved.object,
  );
  if (!checked.success) {
    return {
      ...carried,
      errors: issueErrors(entity, "authoritative", raw, checked.error),
      object: null,
    };
  }

  // The authoritative schema keeps the second amount as the string it judged; its integer, read once
  // in the account's currency, rides back beside it for the commit.
  const counter = (resolved.object as { counterAmountCents?: number }).counterAmountCents;
  const object = counter !== undefined ? { ...checked.data, counterAmountCents: counter } : checked.data;
  const owned = ownedKey(entity, object);
  const ownedStatus = owned === null ? status : existingRefs.has(owned) ? "update" : "new";
  return { ...carried, status: ownedStatus, errors: [], object };
}

// A blank reference becomes a key derived from the row's own content, so the same file imported
// again lands on the same rows (RF-52). `twins` counts the identical rows already keyed in the
// sheet: two equal rows keep two keys, and neither depends on where it sits.
function withContentKeys(entity: SheetEntity, rows: ParsedRow[]): void {
  const twins = new Map<string, number>();
  for (const row of rows) {
    const record = row.record as RawRow;
    if (text(record.externalRef).length > 0) continue;
    const content = Object.keys(record)
      .filter((key) => key !== "externalRef")
      .sort()
      .flatMap((key) => {
        const value = record[key];
        const cell = typeof value === "string" ? value.trim() : value;
        return cell == null || cell === "" ? [] : [[key, cell]];
      });
    const body = JSON.stringify([entity, content]);
    const k = twins.get(body) ?? 0;
    twins.set(body, k + 1);
    const digest = createHash("sha256").update(`${body}\u0000${k}`).digest("hex");
    record.externalRef = `imp:${digest.slice(0, 32)}`;
  }
}

// The reverse label maps, built from the SAME `data` namespace the writer used for
// the request locale, so a file downloaded in either language round-trips (RF-49).
async function reverseLabels(): Promise<ReverseSheetLabels> {
  const t = await getTranslations({ locale: await getLocale(), namespace: "data" });
  type Key = Parameters<typeof t>[0];

  const entityBySheetName = new Map(
    SHEET_ENTITIES.map((entity) => [t(`sheets.${entity}` as Key), entity] as const),
  );

  const columnKeyByHeader = new Map(
    SHEET_ENTITIES.map((entity) => {
      const columns = sheetDescriptors[entity].columns as readonly { key: string }[];
      const headerToKey = new Map(
        columns.map((column) => [t(`columns.${column.key}` as Key), column.key] as const),
      );
      return [entity, headerToKey] as const;
    }),
  );

  return { entityBySheetName, columnKeyByHeader };
}

export function buildEffectiveRefs(
  scope: ImportScope,
  recordsOf: (entity: SheetEntity) => RawRow[],
): EffectiveRefs {
  const places: EffectiveRefs["places"] = {
    personal: scopeKeyOf({ ownerUserId: scope.caller.userId, groupId: null })!,
    group: scopeKeyOf({ ownerUserId: null, groupId: scope.caller.groupId }),
  };
  const fundOrOwn = places.group ?? places.personal;
  return {
    accounts: buildEffectiveMap(scope.accounts, recordsOf("accounts"), "accounts"),
    categories: buildEffectiveMap(scope.categories, recordsOf("categories"), "categories"),
    labels: buildEffectiveMap(scope.labels, recordsOf("labels"), "labels"),
    goals: buildEffectiveMap(scope.goals, recordsOf("goals"), "goals"),
    movementKeys: new Set([
      ...scope.existingRefs.transactions,
      ...recordsOf("transactions").flatMap((raw) => (text(raw.externalRef).length > 0 ? [text(raw.externalRef)] : [])),
    ]),
    places,
    accountCurrencies: buildAccountCurrencies(scope.accounts, recordsOf("accounts")),
    accountCurrencyByRef: new Map(
      scope.accounts.flatMap((account) =>
        account.externalRef != null ? [[account.externalRef, account.settlementCurrency] as const] : [],
      ),
    ),
    categoryKinds: buildCategoryKinds(scope.categories, recordsOf("categories")),
    accountOpenings: buildAccountOpenings(scope.accounts, recordsOf("accounts")),
    // Mirrors the commit: a new account lands by its placement, a new category in the
    // caller's fund when there is one, else with the caller.
    accountScopes: buildScopes<ScopeKey | null>(scope.accounts, recordsOf("accounts"), "accounts", (raw) =>
      text(raw.placement) === "group" ? places.group : places.personal,
    ),
    categoryScopes: buildScopes<ScopeKey>(scope.categories, recordsOf("categories"), "categories", () => fundOrOwn),
    // A file-new label lands by its placement; blank, where a file-new category does.
    labelScopes: buildScopes<ScopeKey | null>(scope.labels, recordsOf("labels"), "labels", (raw) => {
      const placement = text(raw.placement);
      return placement === "group" ? places.group : placement === "personal" ? places.personal : fundOrOwn;
    }),
  };
}

/**
 * The import pipeline (RF-51/52), the single validation path both `preview` and a
 * later `commit` run so they agree to the row: parse the upload, enforce the cap,
 * build the effective post-import sets, then push every row through the three gates.
 * References resolve against existing scope UNIONED with the file's own new accounts
 * and categories, so a full single-file dev→prod migration links a movement to an
 * account created in the same file. Writes NOTHING; the resolved rows ride along for
 * a commit to apply. RLS bounds every read to the caller's scope.
 */
export async function runImportPipeline(input: { buffer: ArrayBuffer }): Promise<ImportResult> {
  if (!zipWithin(new Uint8Array(input.buffer), ZIP_CAPS)) throw new ActionError(NOT_A_WORKBOOK);
  const parsed = await parseWorkbook({ buffer: input.buffer, labels: await reverseLabels() });
  for (const entity of SHEET_ENTITIES) withContentKeys(entity, parsed[entity] ?? []);

  // The cap is measured before any per-row work, across every sheet (RNF-15).
  const total = SHEET_ENTITIES.reduce((sum, entity) => sum + (parsed[entity]?.length ?? 0), 0);
  if (total > MAX_DATA_ROWS) throw new ActionError(TOO_MANY_ROWS);

  const scope: ImportScope = await readImportScope();

  // Every downstream cross-row check (the effective sets, RF-27's kind map) reads
  // the record only — the row it came from is meaningless before it is resolved.
  const recordsOf = (entity: SheetEntity) =>
    (parsed[entity] ?? []).map((row) => row.record) as RawRow[];

  const refs = buildEffectiveRefs(scope, recordsOf);

  const totals = { new: 0, update: 0, error: 0 };
  const perEntity: ImportEntityResult[] = SHEET_ENTITIES.map((entity) => {
    const existingRefs = scope.existingRefs[entity];
    const rows = (parsed[entity] ?? []).map((row, index) =>
      processRow(entity, row.record as RawRow, index, row.sheetRow, refs, existingRefs),
    );
    refuseRepeated(entity, rows);

    for (const row of rows) {
      if (row.errors.length > 0) totals.error += 1;
      else totals[row.status] += 1;
    }

    return { entity, rows };
  });

  return { perEntity, totals };
}
