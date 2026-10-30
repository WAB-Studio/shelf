import { inArray, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import {
  accountReconciliations,
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
  transactionLabels,
  transactionSplits,
  transactions,
} from "@/db/schema";
import type { Transaction } from "@/db/session";
import { BASE_CURRENCY } from "@/lib/currency";
import { insertRow } from "@/db/insert-row";
import { pgConstraintName, pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { parseAmount } from "@/lib/money";
import type { SheetEntity } from "@/lib/spreadsheet/schema";
import { TIME_ZONE } from "@/lib/locales";
import type { CreateAccountInput } from "@/lib/validation/account";
import type { CreateBudgetInput } from "@/lib/validation/budget";
import { percentToFraction, type DebtTermsInput } from "@/lib/validation/debt-terms";
import type { CreateGoalInput } from "@/lib/validation/savings-goal";
import type { ImportedAdjustment } from "@/lib/validation/account-reconciliation";
import type { CreateCategoryInput } from "@/lib/validation/category";
import type { ImportedLabel } from "@/lib/validation/label";
import type { CreateMemberInput } from "@/lib/validation/member";
import type { CreateRecurringRuleInput } from "@/lib/validation/recurring-rule";
import type { CreateTransactionInput } from "@/lib/validation/transaction";

// This module is written WITHOUT `import "server-only"` on purpose: the RLS proof
// (`scripts/check-rls.ts`) calls `commitImport` directly under an injected user, and
// `server-only` cannot resolve outside the Next bundler. Every write below therefore
// takes a caller-supplied transaction and lists only the columns the `authenticated`
// role is granted — the scope, `kind`, `created_by` and an omitted `external_ref` are
// the BEFORE INSERT triggers' to derive (RF-45 audit fires on each), never sent.

// The scope decisions come from the caller's session, resolved once outside the tx and
// never trusted from the file: a personal row names the user, a group row the group.
export type CommitScope = { userId: string; groupId: string | null };

// One classified, validated row the commit writes. `index` is its array position,
// carried for no reason but seeding a NEW row's placeholder upstream — never shown
// to a person. `sheetRow` is the row this same line carries in the spreadsheet
// (RF-51): what a person sees opening the file in Excel, and what names the row if
// this very one is what a later write refuses — a blank row skipped upstream pulls
// the two apart, so neither substitutes for the other. `externalRef` is the stable
// per-scope key (RF-52): present on an update to locate the row, written on an
// insert unless blank. `placeholderId` is set only for a NEW account, category, label or goal,
// so a reference to it remaps to its REAL inserted id. `object` is the entity's
// `createXSchema` payload.
export type CommitRow<T> = {
  index: number;
  sheetRow: number;
  status: "new" | "update";
  externalRef: string | null;
  placeholderId: string | null;
  object: T;
  // What the pipeline found wrong with the row; a row carrying any has no object to write.
  errors?: readonly unknown[];
};

// What a row-level write failure reports back to the confirm screen (RF-51): the
// sheet, its row and a reason the screen already knows how to translate — the very
// keys `mapTransactionError` throws from the live create action. JSON-encoded into
// the one string `ActionError` carries, since a rolled-back commit still owes the
// row it choked on, not just that one did. `sheetRow` is the number a person reads
// opening the file, never the row's array position.
export type CommitRowFailure = { entity: SheetEntity; sheetRow: number; reasonKey: string };

// `cause` carries the original throw (a raw PostgresError included) so a caller
// walking the chain with `pgErrorCode` — `scripts/check-rls.ts`'s own proof does —
// still finds the sqlstate under this wrapper, same as before this named the row.
function rowFailure(
  entity: SheetEntity,
  sheetRow: number,
  reasonKey: string,
  cause: unknown,
): ActionError {
  const failure: CommitRowFailure = { entity, sheetRow, reasonKey };
  const error = new ActionError(JSON.stringify(failure));
  error.cause = cause;
  return error;
}

// The per-scope `external_ref` unique indexes (RF-52). The commit re-reads the file against the
// fund right before it writes, so a key it classified new and still meets here was written by a
// second commit of the same file that landed first — two tabs, or a double confirm.
const EXTERNAL_REF_INDEXES = new Set([
  "group_members_group_external_ref_unique",
  "categories_owner_external_ref_unique",
  "categories_group_external_ref_unique",
  "labels_owner_external_ref_unique",
  "labels_group_external_ref_unique",
  "accounts_owner_external_ref_unique",
  "accounts_group_external_ref_unique",
  "recurring_rules_owner_external_ref_unique",
  "recurring_rules_group_external_ref_unique",
  "transactions_owner_external_ref_unique",
  "transactions_group_external_ref_unique",
  "budgets_owner_external_ref_unique",
  "budgets_group_external_ref_unique",
  "savings_goals_owner_external_ref_unique",
  "savings_goals_group_external_ref_unique",
  "goal_contributions_goal_external_ref_unique",
]);

/**
 * A commit that lost the race to another commit of the same file. `cause` keeps the original
 * throw, a row failure included, so the sqlstate still reads through `pgErrorCode`.
 */
export class ImportAlreadyCommitting extends Error {
  constructor(cause: unknown) {
    super("import-commit: another commit of this file wrote its keys first");
    this.name = "ImportAlreadyCommitting";
    this.cause = cause;
  }
}

function isExternalRefClash(error: unknown): boolean {
  const constraint = pgConstraintName(error);
  return pgErrorCode(error) === "23505" && constraint !== undefined && EXTERNAL_REF_INDEXES.has(constraint);
}

// `assert_split_matches_transaction` and its neighbours raise these; the preview
// already refuses a category/direction mismatch before a commit ever reaches here
// (RF-27), so this is the net under a race the preview could not see — a category
// or account edited or removed between preview and confirm. Mirrors
// `mapTransactionError` in the live create action, minus the throw: this caller
// still has a row index to attach to whichever reason wins.
const CURRENCY_REFUSAL = "23901";
// `transactions_after_opening` (RF-162): the preview refuses the same row on its day.
const BEFORE_OPENING_REFUSAL = "MO001";

function transactionReasonKey(error: unknown): string {
  const code = pgErrorCode(error);
  if (code === "42501") return "errors.notFound";
  if (code === CURRENCY_REFUSAL) return "transactions.errors.currencyMismatch";
  if (code === BEFORE_OPENING_REFUSAL) return "data.import.errors.beforeOpening";
  if (code === "23514") return "transactions.errors.splitsScopeViolation";
  if (code === "23503") return "errors.referenceGone";
  return "errors.unexpected";
}

// The whole file's passing rows, in the entity buckets the pipeline produced. The
// commit walks them in dependency order (RF-51): members and categories, then accounts,
// then recurring rules and transactions.
export type CommitInput = {
  members: CommitRow<CreateMemberInput>[];
  categories: CommitRow<CreateCategoryInput>[];
  labels?: CommitRow<ImportedLabel>[];
  accounts: CommitRow<CreateAccountInput>[];
  recurringRules: CommitRow<CreateRecurringRuleInput>[];
  transactions: CommitRow<CreateTransactionInput>[];
  // A backup's reconciliation adjustments (RF-50): booked as reconciliations, never as movements.
  adjustments?: CommitRow<ImportedAdjustment>[];
  budgets?: CommitRow<RestoredBudget>[];
  goals?: CommitRow<RestoredGoal>[];
  goalContributions?: CommitRow<RestoredContribution>[];
  debts?: CommitRow<DebtTermsInput>[];
  statements?: CommitRow<RestoredStatement>[];
};

// What a backup row adds to a budget's or a goal's form: its place and whether it is archived.
type Restored = { placement: "personal" | "group"; archived: boolean };
export type RestoredBudget = CreateBudgetInput & Restored;
export type RestoredGoal = Omit<CreateGoalInput, "initialContribution"> & Restored;
// The day it was set aside, and the movement it earmarks by that movement's key (RF-87).
export type RestoredContribution = { goalId: string; amount: string; contributedOn: string; movement: string | null };
// A closed statement as the ledger holds it: its figures signed decimals (RF-129).
export type RestoredStatement = {
  accountId: string;
  periodStart: string;
  cutOffDate: string;
  paymentDueDate: string | null;
  openingBalance: string | null;
  closingBalance: string;
  credits: string | null;
  debits: string | null;
  minimumPayment: string | null;
  interestCharged: string | null;
  feesCharged: string | null;
  source: string;
};

export type CommitOutcome = { inserted: number; updated: number };

// The key the commit action raises for the same refusal, so the screen reads one message.
const FILE_HAS_ERRORS = "data.import.errors.hasErrors";

// A multi-row statement stays well under the free tier's execution budget (RNF-15); a
// larger file chunks into several, all inside the one transaction so all-or-nothing holds.
const CHUNK_SIZE = 500;

// The scalar shapes a written cell can carry before Postgres reads the target column's type.
type Cell = string | number | boolean | null;

// A returning row every insert reads back: the real id the triggers stamped, and the key
// the same insert wrote or the trigger backfilled.
type Inserted = { id: string; external_ref: string | null };

// A validated peso string turned into the integer cents the model stores (RNF-05,
// RF-126); the schema already proved it parses, so a null here would be a schema
// that let one through. Reads through `parseAmount`, not `parsePesos`, so a row's
// own centavos — a bank's interest, its 4x1000, a settled foreign purchase —
// reach the column exactly instead of being rounded away on the way in.
function toCents(peso: string): number {
  const cents = parseAmount(peso);
  if (cents === null) throw new Error("import-commit: an amount reached the writer unparsed");
  return cents;
}

// A reference that still holds a placeholder after remapping never reaches a column: a
// missed link would silently orphan a movement, so it fails the whole transaction (RF-51).
function assertLinked(value: string | null, placeholders: Set<string>): void {
  if (value !== null && placeholders.has(value)) {
    throw new Error("import-commit: a placeholder id reached a written column");
  }
}

// One entity's new rows as a chunked, explicit-column multi-row insert (RNF-15). The
// column list names only granted columns, so the triggers own the rest; RETURNING rides
// in VALUES order, so the caller zips each real id back to the source row it came from.
async function insertChunked(
  tx: Transaction,
  table: PgTable,
  columns: string[],
  rows: Cell[][],
): Promise<Inserted[]> {
  const out: Inserted[] = [];
  const colList = sql.join(
    columns.map((column) => sql.identifier(column)),
    sql`, `,
  );

  for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
    const chunk = rows.slice(start, start + CHUNK_SIZE);
    const valuesList = sql.join(
      chunk.map((row) => sql`(${sql.join(row.map((cell) => sql`${cell}`), sql`, `)})`),
      sql`, `,
    );
    const returned = (await tx.execute(
      sql`insert into ${table} (${colList}) values ${valuesList} returning id, external_ref`,
    )) as unknown as Inserted[];
    out.push(...returned);
  }

  return out;
}

// The rows in the chunks a multi-row statement takes (RNF-15).
function chunked<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < rows.length; start += CHUNK_SIZE) out.push(rows.slice(start, start + CHUNK_SIZE));
  return out;
}

// A set of records as ONE jsonb parameter for `jsonb_to_recordset` / `jsonb_array_elements_text`:
// Drizzle expands a JS array into a parenthesised list, never an array (docs/TRAPS.md).
function jsonbParam(value: unknown): SQL {
  return sql`${JSON.stringify(value)}::jsonb`;
}

/**
 * Write the whole import in ONE caller-supplied transaction (RF-51): every insert and
 * update runs against `tx`, so a single failure rolls back ALL of it and the audit
 * trigger captures each write (RF-45). Rows classified `new` insert; rows classified
 * `update` overwrite the existing row by its `external_ref` within scope (RF-52). A
 * reference to a file-new account, category, label or goal resolves to that entity's REAL inserted
 * id through the placeholder maps built as the accounts and categories land — never the
 * pipeline's placeholder. The caller opens the transaction (`withUserDb`) and settles the
 * session; this function only writes.
 */
export async function commitImport(
  tx: Transaction,
  input: CommitInput,
  scope: CommitScope,
): Promise<CommitOutcome> {
  // All or nothing (RF-51), whoever assembled the input: one errored row anywhere refuses the
  // whole file before a single write, a clean row beside it included.
  const buckets: CommitRow<unknown>[][] = [
    input.members,
    input.categories,
    input.labels ?? [],
    input.accounts,
    input.recurringRules,
    input.transactions,
    input.adjustments ?? [],
    input.budgets ?? [],
    input.goals ?? [],
    input.goalContributions ?? [],
    input.debts ?? [],
    input.statements ?? [],
  ];
  if (buckets.some((rows) => rows.some((row) => (row.errors?.length ?? 0) > 0 || row.object == null))) {
    throw new ActionError(FILE_HAS_ERRORS);
  }

  try {
    return await writeImport(tx, input, scope);
  } catch (error) {
    if (isExternalRefClash(error)) throw new ImportAlreadyCommitting(error);
    throw error;
  }
}

async function writeImport(
  tx: Transaction,
  input: CommitInput,
  scope: CommitScope,
): Promise<CommitOutcome> {
  const outcome: CommitOutcome = { inserted: 0, updated: 0 };
  const count = (row: CommitRow<unknown>) => {
    if (row.status === "new") outcome.inserted += 1;
    else outcome.updated += 1;
  };

  // Members and categories first: a member row needs the caller's group, a category its
  // scope, both resolved from the session (RF-63), never from the file.
  await commitMembers(tx, input.members, scope);
  const categoryMap = await commitCategories(tx, input.categories, scope);
  const labelMap = await commitLabels(tx, input.labels ?? [], scope);

  // Then accounts, so a movement or rule that names one can link to its real id.
  const accountMap = await commitAccounts(tx, input.accounts, scope);

  // Reject before a single recurring rule lands (RF-121): a rule's generator
  // books in the account's currency, which the sheet does not carry. A transaction
  // row is held to its account's currency by the pipeline and, at write time, by
  // `assert_transaction_currency`.
  await assertBaseCurrencyAccounts(
    tx,
    input.recurringRules.map((row) => row.object),
    accountMap,
  );

  // The placeholders any reference could still be carrying: the union of every file-new
  // account and category. After remap, no written reference may be one of these.
  const placeholders = new Set<string>([...accountMap.keys(), ...categoryMap.keys(), ...labelMap.keys()]);

  await commitRecurringRules(tx, input.recurringRules, accountMap, categoryMap, placeholders, scope);
  await commitTransactions(tx, input.transactions, accountMap, categoryMap, placeholders, scope);
  await commitTransactionLabels(tx, input.transactions, labelMap, placeholders, scope);

  await commitAdjustments(tx, input.adjustments ?? [], accountMap, placeholders);

  // Goals before their contributions, both after the movements a contribution earmarks; a
  // goal is archived only once its contributions are in, since an archived one takes none.
  const goalMap = await commitGoals(tx, input.goals ?? [], accountMap, placeholders, scope);
  for (const id of goalMap.keys()) placeholders.add(id);
  await commitContributions(tx, input.goalContributions ?? [], goalMap, placeholders, scope);
  await commitBudgets(tx, input.budgets ?? [], { accountMap, categoryMap, labelMap }, placeholders, scope);
  await archiveRestored(tx, savingsGoals, input.goals ?? [], scope);
  await archiveRestored(tx, budgets, input.budgets ?? [], scope);
  await commitDebts(tx, input.debts ?? [], accountMap, placeholders);
  await commitStatements(tx, input.statements ?? [], accountMap, placeholders);

  for (const bucket of [
    input.members,
    input.categories,
    input.labels ?? [],
    input.accounts,
    input.recurringRules,
    input.transactions,
    input.adjustments ?? [],
    input.budgets ?? [],
    input.goals ?? [],
    input.goalContributions ?? [],
    input.debts ?? [],
    input.statements ?? [],
  ]) {
    for (const row of bucket) count(row);
  }

  return outcome;
}

// The caller's group for a category or an account marked group-placed; a row that needs
// a group the caller lacks cannot land, so the write fails loudly (RF-51).
function requireGroup(groupId: string | null): string {
  if (!groupId) throw new Error("import-commit: a group-scoped row has no group to land in");
  return groupId;
}

async function commitMembers(
  tx: Transaction,
  rows: CommitRow<CreateMemberInput>[],
  scope: CommitScope,
): Promise<void> {
  if (rows.length === 0) return;
  const groupId = requireGroup(scope.groupId);

  const newRows = rows.filter((row) => row.status === "new");
  if (newRows.length > 0) {
    await insertChunked(
      tx,
      groupMembers,
      ["group_id", "name", "invite_email", "external_ref"],
      newRows.map((row) => [groupId, row.object.name, row.object.email ?? null, row.externalRef]),
    );
  }

  const updates = rows
    .filter((row) => row.status === "update")
    .map((row) => ({ external_ref: row.externalRef, name: row.object.name, invite_email: row.object.email ?? null }));
  for (const chunk of chunked(updates)) {
    await tx.execute(sql`
      update ${groupMembers} as m set name = r.name, invite_email = r.invite_email
      from jsonb_to_recordset(${jsonbParam(chunk)}) as r(external_ref text, name text, invite_email text)
      where m.group_id = ${groupId} and m.external_ref = r.external_ref`);
  }
}

// Categories in two passes: a top-level parent lands first so a child (matched by its own
// placeholder) links to the parent's real id, and both feed the map a rule or movement
// resolves its category through.
async function commitCategories(
  tx: Transaction,
  rows: CommitRow<CreateCategoryInput>[],
  scope: CommitScope,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (rows.length === 0) return map;

  const ownerUserId = scope.groupId ? null : scope.userId;
  const groupId = scope.groupId;
  const columns = ["owner_user_id", "group_id", "name", "kind", "parent_id", "color", "external_ref"];

  const record = (source: CommitRow<CreateCategoryInput>[], inserted: Inserted[]) => {
    source.forEach((row, index) => {
      if (row.placeholderId) map.set(row.placeholderId, inserted[index].id);
    });
  };

  // Pass one: top-level new categories. Pass two: new subcategories, their parent remapped
  // to the real id the first pass minted.
  const newParents = rows.filter((row) => row.status === "new" && row.object.parentId === null);
  const newChildren = rows.filter((row) => row.status === "new" && row.object.parentId !== null);

  if (newParents.length > 0) {
    record(
      newParents,
      await insertChunked(
        tx,
        categories,
        columns,
        newParents.map((row) => [
          ownerUserId,
          groupId,
          row.object.name,
          row.object.kind,
          null,
          row.object.color,
          row.externalRef,
        ]),
      ),
    );
  }

  if (newChildren.length > 0) {
    record(
      newChildren,
      await insertChunked(
        tx,
        categories,
        columns,
        newChildren.map((row) => [
          ownerUserId,
          groupId,
          row.object.name,
          row.object.kind,
          map.get(row.object.parentId!) ?? row.object.parentId,
          row.object.color,
          row.externalRef,
        ]),
      ),
    );
  }

  const updates = rows
    .filter((row) => row.status === "update")
    .map((row) => ({
      external_ref: row.externalRef,
      name: row.object.name,
      parent_id: row.object.parentId === null ? null : map.get(row.object.parentId) ?? row.object.parentId,
      color: row.object.color,
    }));
  const inScope = groupId ? sql`c.group_id = ${groupId}` : sql`c.owner_user_id = ${scope.userId}`;
  for (const chunk of chunked(updates)) {
    await tx.execute(sql`
      update ${categories} as c set name = r.name, parent_id = r.parent_id, color = r.color
      from jsonb_to_recordset(${jsonbParam(chunk)}) as r(external_ref text, name text, parent_id uuid, color text)
      where c.external_ref = r.external_ref and ${inScope}`);
  }

  return map;
}

// Labels land where a new category does: the caller's fund when there is one, else with the
// caller (RF-70). The map remaps a file-new label's placeholder to its real id.
async function commitLabels(
  tx: Transaction,
  rows: CommitRow<ImportedLabel>[],
  scope: CommitScope,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (rows.length === 0) return map;

  const ownerUserId = scope.groupId ? null : scope.userId;
  const newRows = rows.filter((row) => row.status === "new");
  if (newRows.length > 0) {
    const inserted = await insertChunked(
      tx,
      labels,
      ["owner_user_id", "group_id", "name", "color", "external_ref"],
      newRows.map((row) => [ownerUserId, scope.groupId, row.object.name, row.object.color, row.externalRef]),
    );
    newRows.forEach((row, index) => {
      if (row.placeholderId) map.set(row.placeholderId, inserted[index].id);
    });
  }

  const updates = rows
    .filter((row) => row.status === "update")
    .map((row) => ({ external_ref: row.externalRef, name: row.object.name, color: row.object.color }));
  for (const chunk of chunked(updates)) {
    await tx.execute(sql`
      update ${labels} as t set name = r.name, color = r.color
      from jsonb_to_recordset(${jsonbParam(chunk)}) as r(external_ref text, name text, color text)
      where t.external_ref = r.external_ref and ${inScope(scope)}`);
  }

  return map;
}

async function commitAccounts(
  tx: Transaction,
  rows: CommitRow<CreateAccountInput>[],
  scope: CommitScope,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (rows.length === 0) return map;

  // A liability opens negative so net worth stays a plain sum (RNF-05); placement decides
  // the scope columns, resolved from the session the same way `createAccountAction` does.
  const placementColumns = (placement: CreateAccountInput["placement"]) =>
    placement === "group"
      ? { ownerUserId: null as string | null, groupId: requireGroup(scope.groupId), isShared: true }
      : { ownerUserId: scope.userId, groupId: null as string | null, isShared: false };

  const columns = [
    "owner_user_id",
    "group_id",
    "name",
    "kind",
    "subtype",
    "institution",
    "is_shared",
    "initial_balance_cents",
    "initial_balance_on",
    "settlement_currency",
    "external_ref",
  ];

  const newRows = rows.filter((row) => row.status === "new");
  if (newRows.length > 0) {
    const inserted = await insertChunked(
      tx,
      accounts,
      columns,
      newRows.map((row) => {
        const scoped = placementColumns(row.object.placement);
        const cents = toCents(row.object.amount);
        return [
          scoped.ownerUserId,
          scoped.groupId,
          row.object.name,
          row.object.kind,
          row.object.subtype,
          row.object.institution,
          scoped.isShared,
          row.object.kind === "liability" ? -cents : cents,
          row.object.balanceOn,
          row.object.settlementCurrency,
          row.externalRef,
        ];
      }),
    );
    newRows.forEach((row, index) => {
      if (row.placeholderId) map.set(row.placeholderId, inserted[index].id);
    });
  }

  // Each row carries the group its placement lands in, so one statement holds both scopes.
  const updates = rows
    .filter((row) => row.status === "update")
    .map((row) => {
      const scoped = placementColumns(row.object.placement);
      const cents = toCents(row.object.amount);
      return {
        external_ref: row.externalRef,
        group_id: scoped.groupId,
        name: row.object.name,
        subtype: row.object.subtype,
        is_shared: scoped.isShared,
        institution: row.object.institution,
        initial_balance_cents: row.object.kind === "liability" ? -cents : cents,
        initial_balance_on: row.object.balanceOn,
      };
    });
  for (const chunk of chunked(updates)) {
    await tx.execute(sql`
      update ${accounts} as a set
        name = r.name, subtype = r.subtype, is_shared = r.is_shared, institution = r.institution,
        initial_balance_cents = r.initial_balance_cents, initial_balance_on = r.initial_balance_on
      from jsonb_to_recordset(${jsonbParam(chunk)}) as r(
        external_ref text, group_id uuid, name text, subtype text, is_shared boolean, institution text,
        initial_balance_cents bigint, initial_balance_on date)
      where a.external_ref = r.external_ref
        and (case when r.group_id is null then a.owner_user_id = ${scope.userId} else a.group_id = r.group_id end)`);
  }

  return map;
}

// A reference to a file-new entity carries that entity's placeholder; the map turns it
// into the real inserted id, and a reference to an existing entity passes through unchanged.
function link(value: string | null, map: Map<string, string>): string | null {
  if (value === null) return null;
  return map.get(value) ?? value;
}

// The settlement currency of every account a recurring rule or transaction row names,
// read back in one round trip (RF-121). A file-new account carries the settlement
// currency its sheet row named; the check walks it like any other, per row, and
// stops at the first mismatch.
async function assertBaseCurrencyAccounts(
  tx: Transaction,
  rows: { fromAccountId: string | null; toAccountId: string | null }[],
  accountMap: Map<string, string>,
): Promise<void> {
  const linkedIds = rows.map((row) => ({
    fromAccountId: link(row.fromAccountId, accountMap),
    toAccountId: link(row.toAccountId, accountMap),
  }));

  const ids = new Set<string>();
  for (const row of linkedIds) {
    if (row.fromAccountId !== null) ids.add(row.fromAccountId);
    if (row.toAccountId !== null) ids.add(row.toAccountId);
  }
  if (ids.size === 0) return;

  const currencyById = new Map(
    (
      await tx
        .select({ id: accounts.id, settlementCurrency: accounts.settlementCurrency })
        .from(accounts)
        .where(inArray(accounts.id, [...ids]))
    ).map((account) => [account.id, account.settlementCurrency]),
  );

  const isForeign = (id: string | null) =>
    id !== null && currencyById.get(id) !== undefined && currencyById.get(id) !== BASE_CURRENCY;

  for (const row of linkedIds) {
    if (isForeign(row.fromAccountId) || isForeign(row.toAccountId)) {
      throw new ActionError("errors.foreignCurrencyUnsupported");
    }
  }
}

async function commitRecurringRules(
  tx: Transaction,
  rows: CommitRow<CreateRecurringRuleInput>[],
  accountMap: Map<string, string>,
  categoryMap: Map<string, string>,
  placeholders: Set<string>,
  scope: CommitScope,
): Promise<void> {
  if (rows.length === 0) return;

  const resolve = (object: CreateRecurringRuleInput) => {
    const fromAccountId = link(object.fromAccountId, accountMap);
    const toAccountId = link(object.toAccountId, accountMap);
    const categoryId = link(object.categoryId, categoryMap)!;
    assertLinked(fromAccountId, placeholders);
    assertLinked(toAccountId, placeholders);
    assertLinked(categoryId, placeholders);
    return { fromAccountId, toAccountId, categoryId };
  };

  const columns = [
    "from_account_id",
    "to_account_id",
    "amount_cents",
    "category_id",
    "description",
    "frequency",
    "interval_n",
    "day_of_month",
    "next_run_on",
    "ends_on",
    "external_ref",
  ];

  const newRows = rows.filter((row) => row.status === "new");
  if (newRows.length > 0) {
    await insertChunked(
      tx,
      recurringRules,
      columns,
      newRows.map((row) => {
        const linked = resolve(row.object);
        return [
          linked.fromAccountId,
          linked.toAccountId,
          toCents(row.object.amount),
          linked.categoryId,
          row.object.description ?? null,
          row.object.frequency,
          row.object.intervalN,
          row.object.dayOfMonth ?? null,
          row.object.nextRunOn,
          row.object.endsOn ?? null,
          row.externalRef,
        ];
      }),
    );
  }

  const updates = rows
    .filter((row) => row.status === "update")
    .map((row) => {
      const linked = resolve(row.object);
      return {
        external_ref: row.externalRef,
        from_account_id: linked.fromAccountId,
        to_account_id: linked.toAccountId,
        amount_cents: toCents(row.object.amount),
        category_id: linked.categoryId,
        description: row.object.description ?? null,
        frequency: row.object.frequency,
        interval_n: row.object.intervalN,
        day_of_month: row.object.dayOfMonth ?? null,
        next_run_on: row.object.nextRunOn,
        ends_on: row.object.endsOn ?? null,
      };
    });
  for (const chunk of chunked(updates)) {
    await tx.execute(sql`
      update ${recurringRules} as t set
        from_account_id = r.from_account_id, to_account_id = r.to_account_id, amount_cents = r.amount_cents,
        category_id = r.category_id, description = r.description, frequency = r.frequency,
        interval_n = r.interval_n, day_of_month = r.day_of_month, next_run_on = r.next_run_on, ends_on = r.ends_on
      from jsonb_to_recordset(${jsonbParam(chunk)}) as r(
        external_ref text, from_account_id uuid, to_account_id uuid, amount_cents bigint, category_id uuid,
        description text, frequency text, interval_n smallint, day_of_month smallint, next_run_on date, ends_on date)
      where t.external_ref = r.external_ref and ${inScope(scope)}`);
  }
}

// An `external_ref` is unique per scope, not globally, and the trigger resolves a row's
// scope from its accounts, so a rule or movement may sit in either of the caller's scopes.
// Written against the alias `t` the rule and movement updates both give their table.
function inScope(scope: CommitScope): SQL {
  return scope.groupId
    ? sql`(t.group_id = ${scope.groupId} or t.owner_user_id = ${scope.userId})`
    : sql`t.owner_user_id = ${scope.userId}`;
}

// A movement's write, resolved once: the real account and category ids a placeholder
// stood for, the cents its amount and splits parse to. Shared by the batch attempt
// and the serial fallback so the two write the exact same values.
type ResolvedTransaction = {
  row: CommitRow<CreateTransactionInput>;
  fromAccountId: string | null;
  toAccountId: string | null;
  amountCents: number;
  // Null on insert leaves `set_transaction_currency` to derive it from the accounts.
  currency: string | null;
  counterAmountCents: number | null;
  counterIsEstimate: boolean;
  splits: { categoryId: string; amountCents: number }[];
};

function resolveTransaction(
  row: CommitRow<CreateTransactionInput>,
  accountMap: Map<string, string>,
  categoryMap: Map<string, string>,
  placeholders: Set<string>,
): ResolvedTransaction {
  const object = row.object;
  const fromAccountId = link(object.fromAccountId, accountMap);
  const toAccountId = link(object.toAccountId, accountMap);
  assertLinked(fromAccountId, placeholders);
  assertLinked(toAccountId, placeholders);

  const splits = object.splits.map((split) => {
    const categoryId = link(split.categoryId, categoryMap)!;
    assertLinked(categoryId, placeholders);
    return { categoryId, amountCents: toCents(split.amount) };
  });

  // The pipeline read the second amount once in its account's currency and carries the
  // integer beside the string; a caller that sends only the string has it read here.
  const carried = (object as { counterAmountCents?: number | null }).counterAmountCents;
  const counterAmountCents =
    carried ?? (object.counterAmount != null && object.counterAmount.trim() !== "" ? toCents(object.counterAmount) : null);

  return {
    row,
    fromAccountId,
    toAccountId,
    amountCents: toCents(object.amount),
    currency: object.currency ?? null,
    counterAmountCents,
    counterIsEstimate: object.counterIsEstimate ?? false,
    splits,
  };
}

// A row resolved for the write, or the row failure naming it (RF-51).
function resolveRows(
  rows: CommitRow<CreateTransactionInput>[],
  accountMap: Map<string, string>,
  categoryMap: Map<string, string>,
  placeholders: Set<string>,
): ResolvedTransaction[] {
  return rows.map((row) => {
    try {
      return resolveTransaction(row, accountMap, categoryMap, placeholders);
    } catch (error) {
      throw rowFailure("transactions", row.sheetRow, transactionReasonKey(error), error);
    }
  });
}

// Transactions carry a child split, so a new row writes the movement then its splits,
// and an update overwrites the row and replaces the split wholesale (delete + insert),
// mirroring `updateTransaction`. Both batch (RNF-15).
async function commitTransactions(
  tx: Transaction,
  rows: CommitRow<CreateTransactionInput>[],
  accountMap: Map<string, string>,
  categoryMap: Map<string, string>,
  placeholders: Set<string>,
  scope: CommitScope,
): Promise<void> {
  const newRows = rows.filter((row) => row.status === "new");
  const updateRows = rows.filter((row) => row.status === "update");

  await commitNewTransactions(tx, newRows, accountMap, categoryMap, placeholders);
  await commitUpdatedTransactions(tx, updateRows, accountMap, categoryMap, placeholders, scope);
}

// Updates ride the same savepoint-then-serial shape as new rows: the set-based write runs
// once for the whole file, and only a refused batch pays for redoing it row by row to name
// the row an ordinary commit would have refused.
async function commitUpdatedTransactions(
  tx: Transaction,
  rows: CommitRow<CreateTransactionInput>[],
  accountMap: Map<string, string>,
  categoryMap: Map<string, string>,
  placeholders: Set<string>,
  scope: CommitScope,
): Promise<void> {
  if (rows.length === 0) return;
  const resolved = resolveRows(rows, accountMap, categoryMap, placeholders);

  try {
    await tx.transaction(async (sp) => {
      for (const chunk of chunked(resolved)) await updateTransactionsBatch(sp, chunk, scope);
    });
  } catch {
    for (const item of resolved) {
      try {
        await updateTransactionsBatch(tx, [item], scope);
      } catch (error) {
        throw rowFailure("transactions", item.row.sheetRow, transactionReasonKey(error), error);
      }
    }
  }
}

// Four statements per chunk whatever its size: the movements, their old splits and labels
// gone, their new splits in. A key that matches nothing in scope writes no split.
async function updateTransactionsBatch(
  tx: Transaction,
  chunk: ResolvedTransaction[],
  scope: CommitScope,
): Promise<void> {
  const records = chunk.map((item) => ({
    external_ref: item.row.externalRef,
    from_account_id: item.fromAccountId,
    to_account_id: item.toAccountId,
    amount_cents: item.amountCents,
    currency: item.currency,
    counter_amount_cents: item.counterAmountCents,
    counter_is_estimate: item.counterIsEstimate,
    occurred_at: item.row.object.occurredAt,
    description: item.row.object.description,
  }));
  // Mirrors `updateTransaction`: correcting a generated, unreviewed movement also
  // confirms it, while a manual or already-reviewed row's stamp stays put (RF-31).
  // A row with no currency, from a sheet written before the column existed, says
  // nothing of it: the stored currency and its second amount stay as they are.
  const updated = (await tx.execute(sql`
    update ${transactions} as t set
      from_account_id = r.from_account_id, to_account_id = r.to_account_id, amount_cents = r.amount_cents,
      currency = coalesce(r.currency, t.currency),
      counter_amount_cents = case when r.currency is null then t.counter_amount_cents else r.counter_amount_cents end,
      counter_is_estimate = case when r.currency is null then t.counter_is_estimate else r.counter_is_estimate end,
      occurred_at = r.occurred_at, description = r.description,
      reviewed_at = case when t.recurring_rule_id is not null and t.reviewed_at is null then now() else t.reviewed_at end
    from jsonb_to_recordset(${jsonbParam(records)}) as r(
      external_ref text, from_account_id uuid, to_account_id uuid, amount_cents bigint, currency text,
      counter_amount_cents bigint, counter_is_estimate boolean, occurred_at date, description text)
    where t.external_ref = r.external_ref and ${inScope(scope)}
    returning t.id, t.external_ref`)) as unknown as { id: string; external_ref: string }[];
  if (updated.length === 0) return;

  const ids = sql`(select value::uuid from jsonb_array_elements_text(${jsonbParam(updated.map((row) => row.id))}))`;
  await tx.execute(sql`delete from ${transactionSplits} where transaction_id in ${ids}`);
  await tx.execute(sql`delete from ${transactionLabels} where transaction_id in ${ids}`);

  const splitsByRef = new Map(chunk.map((item) => [item.row.externalRef, item.splits]));
  const splits = updated.flatMap((row) =>
    (splitsByRef.get(row.external_ref) ?? []).map((split) => ({
      transaction_id: row.id,
      category_id: split.categoryId,
      amount_cents: split.amountCents,
    })),
  );
  if (splits.length === 0) return;
  await tx.execute(sql`
    insert into ${transactionSplits} (transaction_id, category_id, amount_cents)
    select transaction_id, category_id, amount_cents
    from jsonb_to_recordset(${jsonbParam(splits)}) as r(transaction_id uuid, category_id uuid, amount_cents bigint)`);
}

// New rows land in chunked, multi-row inserts (RNF-15): the movements first, then their
// splits, keyed back to each movement's real id in RETURNING order — the same trick
// `insertChunked` plays for every other entity. The whole batch runs inside ONE savepoint
// (RF-51's row naming, not RNF-15, decides the chunk size here): a constraint any single
// row trips aborts only this block, so the outer transaction is still open to redo the
// batch's rows one at a time and name the exact one an ordinary commit would have refused.
// A file with no bad row never pays for that fallback; only a bad file does.
async function commitNewTransactions(
  tx: Transaction,
  rows: CommitRow<CreateTransactionInput>[],
  accountMap: Map<string, string>,
  categoryMap: Map<string, string>,
  placeholders: Set<string>,
): Promise<void> {
  if (rows.length === 0) return;

  const resolved = resolveRows(rows, accountMap, categoryMap, placeholders);

  try {
    await tx.transaction(async (sp) => {
      for (let start = 0; start < resolved.length; start += CHUNK_SIZE) {
        await insertNewTransactionsBatch(sp, resolved.slice(start, start + CHUNK_SIZE));
      }
    });
  } catch {
    await insertNewTransactionsSerially(tx, resolved);
  }
}

// One multi-row insert for the movements, one for every split any of them carries —
// two round trips per chunk instead of two per row. RETURNING rides in VALUES order,
// same assumption `insertChunked` already leans on for every other entity.
async function insertNewTransactionsBatch(
  tx: Transaction,
  chunk: ResolvedTransaction[],
): Promise<void> {
  const rowValues = sql.join(
    chunk.map(
      (item) =>
        sql`(${item.fromAccountId}, ${item.toAccountId}, ${item.amountCents}, ${item.currency},
          ${item.counterAmountCents}, ${item.counterIsEstimate},
          ${item.row.object.occurredAt}, ${item.row.object.description}, ${item.row.externalRef})`,
    ),
    sql`, `,
  );
  const inserted = (await tx.execute(
    sql`insert into ${transactions}
      (from_account_id, to_account_id, amount_cents, currency, counter_amount_cents, counter_is_estimate,
        occurred_at, description, external_ref)
      values ${rowValues}
      returning id`,
  )) as unknown as { id: string }[];

  const splitValues: ReturnType<typeof sql>[] = [];
  chunk.forEach((item, index) => {
    const transactionId = inserted[index].id;
    for (const split of item.splits) {
      splitValues.push(sql`(${transactionId}, ${split.categoryId}, ${split.amountCents})`);
    }
  });
  if (splitValues.length === 0) return;

  await tx.execute(
    sql`insert into ${transactionSplits} (transaction_id, category_id, amount_cents)
      values ${sql.join(splitValues, sql`, `)}`,
  );
}

// The batch's fallback, row by row: the exact write the pre-batching commit made, kept
// here so the one row a chunk chokes on is the one the thrown `ActionError` names.
async function insertNewTransactionsSerially(
  tx: Transaction,
  rows: ResolvedTransaction[],
): Promise<void> {
  for (const item of rows) {
    try {
      const [inserted] = (await tx.execute(
        sql`insert into ${transactions}
          (from_account_id, to_account_id, amount_cents, currency, counter_amount_cents, counter_is_estimate,
            occurred_at, description, external_ref)
          values (${item.fromAccountId}, ${item.toAccountId}, ${item.amountCents}, ${item.currency},
            ${item.counterAmountCents}, ${item.counterIsEstimate}, ${item.row.object.occurredAt}, ${item.row.object.description}, ${item.row.externalRef})
          returning id`,
      )) as unknown as { id: string }[];
      await writeSplits(tx, inserted.id, item.splits);
    } catch (error) {
      throw rowFailure("transactions", item.row.sheetRow, transactionReasonKey(error), error);
    }
  }
}

// The single split an income or expense carries (a transfer carries none); the deferred
// sum trigger checks it at commit, so it need not balance the instant it lands. Its own
// explicit-column insert, since the split table carries no `external_ref` to return.
async function writeSplits(
  tx: Transaction,
  transactionId: string,
  splits: { categoryId: string; amountCents: number }[],
): Promise<void> {
  if (splits.length === 0) return;
  const values = sql.join(
    splits.map(
      (split) => sql`(${transactionId}, ${split.categoryId}, ${split.amountCents})`,
    ),
    sql`, `,
  );
  await tx.execute(
    sql`insert into ${transactionSplits} (transaction_id, category_id, amount_cents) values ${values}`,
  );
}

// The owner and group columns a budget or a goal lands with, by the place its row names.
function placeColumns(placement: "personal" | "group", scope: CommitScope): [string | null, string | null] {
  return placement === "group" ? [null, requireGroup(scope.groupId)] : [scope.userId, null];
}

async function commitGoals(
  tx: Transaction,
  rows: CommitRow<RestoredGoal>[],
  accountMap: Map<string, string>,
  placeholders: Set<string>,
  scope: CommitScope,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const accountOf = (row: CommitRow<RestoredGoal>) => {
    const accountId = link(row.object.accountId ?? null, accountMap);
    assertLinked(accountId, placeholders);
    return accountId;
  };

  const newRows = rows.filter((row) => row.status === "new");
  if (newRows.length > 0) {
    const inserted = await insertChunked(
      tx,
      savingsGoals,
      ["owner_user_id", "group_id", "name", "target_amount_cents", "target_date", "account_id", "external_ref"],
      newRows.map((row) => [
        ...placeColumns(row.object.placement, scope),
        row.object.name,
        toCents(row.object.targetAmount),
        row.object.targetDate ?? null,
        accountOf(row),
        row.externalRef,
      ]),
    );
    newRows.forEach((row, index) => {
      if (row.placeholderId) map.set(row.placeholderId, inserted[index].id);
    });
  }

  const updates = rows
    .filter((row) => row.status === "update")
    .map((row) => ({
      external_ref: row.externalRef,
      name: row.object.name,
      target_amount_cents: toCents(row.object.targetAmount),
      target_date: row.object.targetDate ?? null,
      account_id: accountOf(row),
    }));
  for (const chunk of chunked(updates)) {
    await tx.execute(sql`
      update ${savingsGoals} as t set
        name = r.name, target_amount_cents = r.target_amount_cents, target_date = r.target_date, account_id = r.account_id
      from jsonb_to_recordset(${jsonbParam(chunk)}) as r(
        external_ref text, name text, target_amount_cents bigint, target_date date, account_id uuid)
      where t.external_ref = r.external_ref and ${inScope(scope)}`);
  }

  return map;
}

// A contribution is final once set aside (RF-119 removes it, never edits it), so a key already
// in the fund is left alone. Its day lands at Bogotá noon, which reads back as that day.
async function commitContributions(
  tx: Transaction,
  rows: CommitRow<RestoredContribution>[],
  goalMap: Map<string, string>,
  placeholders: Set<string>,
  scope: CommitScope,
): Promise<void> {
  const records = rows
    .filter((row) => row.status === "new")
    .map((row) => {
      const goalId = link(row.object.goalId, goalMap);
      assertLinked(goalId, placeholders);
      return {
        goal_id: goalId,
        amount_cents: toCents(row.object.amount),
        day: row.object.contributedOn,
        movement: row.object.movement,
        external_ref: row.externalRef,
      };
    });
  for (const chunk of chunked(records)) {
    await tx.execute(sql`
      insert into ${goalContributions} (goal_id, amount_cents, created_at, transaction_id, external_ref)
      select r.goal_id, r.amount_cents, (r.day::date + time '12:00') at time zone ${TIME_ZONE}, t.id, r.external_ref
      from jsonb_to_recordset(${jsonbParam(chunk)}) as r(
        goal_id uuid, amount_cents bigint, day text, movement text, external_ref text)
      left join ${transactions} as t on t.external_ref = r.movement and ${inScope(scope)}`);
  }
}

// A budget's category, account and label share its place; the scope trigger holds them to it.
async function commitBudgets(
  tx: Transaction,
  rows: CommitRow<RestoredBudget>[],
  maps: { accountMap: Map<string, string>; categoryMap: Map<string, string>; labelMap: Map<string, string> },
  placeholders: Set<string>,
  scope: CommitScope,
): Promise<void> {
  const linked = (row: CommitRow<RestoredBudget>) => {
    const categoryId = link(row.object.categoryId, maps.categoryMap)!;
    const accountId = link(row.object.accountId ?? null, maps.accountMap);
    const labelId = link(row.object.labelId ?? null, maps.labelMap);
    for (const id of [categoryId, accountId, labelId]) assertLinked(id, placeholders);
    return { categoryId, accountId, labelId };
  };

  const newRows = rows.filter((row) => row.status === "new");
  if (newRows.length > 0) {
    await insertChunked(
      tx,
      budgets,
      [
        "owner_user_id",
        "group_id",
        "category_id",
        "account_id",
        "label_id",
        "period",
        "limit_cents",
        "threshold_pct",
        "name",
        "external_ref",
      ],
      newRows.map((row) => {
        const ids = linked(row);
        return [
          ...placeColumns(row.object.placement, scope),
          ids.categoryId,
          ids.accountId,
          ids.labelId,
          row.object.period,
          toCents(row.object.limit),
          row.object.thresholdPct,
          row.object.name ?? null,
          row.externalRef,
        ];
      }),
    );
  }

  // The category is immutable (RF-71): an update rewrites the rest.
  const updates = rows
    .filter((row) => row.status === "update")
    .map((row) => {
      const ids = linked(row);
      return {
        external_ref: row.externalRef,
        account_id: ids.accountId,
        label_id: ids.labelId,
        period: row.object.period,
        limit_cents: toCents(row.object.limit),
        threshold_pct: row.object.thresholdPct,
        name: row.object.name ?? null,
      };
    });
  for (const chunk of chunked(updates)) {
    await tx.execute(sql`
      update ${budgets} as t set
        account_id = r.account_id, label_id = r.label_id, period = r.period, limit_cents = r.limit_cents,
        threshold_pct = r.threshold_pct, name = r.name
      from jsonb_to_recordset(${jsonbParam(chunk)}) as r(
        external_ref text, account_id uuid, label_id uuid, period text, limit_cents bigint, threshold_pct smallint, name text)
      where t.external_ref = r.external_ref and ${inScope(scope)}`);
  }
}

// Archived as the file says (RF-120): a row already archived keeps its day, a live one in the
// file comes back to life.
async function archiveRestored(
  tx: Transaction,
  table: typeof budgets | typeof savingsGoals,
  rows: CommitRow<Restored>[],
  scope: CommitScope,
): Promise<void> {
  const records = rows.map((row) => ({ external_ref: row.externalRef, archived: row.object.archived }));
  for (const chunk of chunked(records)) {
    await tx.execute(sql`
      update ${table} as t set archived_at = case when r.archived then coalesce(t.archived_at, now()) end
      from jsonb_to_recordset(${jsonbParam(chunk)}) as r(external_ref text, archived boolean)
      where t.external_ref = r.external_ref and (t.archived_at is null) = r.archived and ${inScope(scope)}`);
  }
}

// An account's terms (RF-78), written over the ones it already carries: the account is the key.
async function commitDebts(
  tx: Transaction,
  rows: CommitRow<DebtTermsInput>[],
  accountMap: Map<string, string>,
  placeholders: Set<string>,
): Promise<void> {
  const cents = (value: string | null | undefined) => (value == null ? null : toCents(value));
  const records = rows.map((row) => {
    const accountId = link(row.object.accountId, accountMap);
    assertLinked(accountId, placeholders);
    return {
      account_id: accountId,
      debt_kind: row.object.debtKind,
      annual_rate: percentToFraction(row.object.annualRate),
      minimum_payment_cents: cents(row.object.minimumPayment),
      minimum_payment_pct: row.object.minimumPaymentPct == null ? null : percentToFraction(row.object.minimumPaymentPct),
      credit_limit_cents: cents(row.object.creditLimit),
      statement_cut_off_day: row.object.statementCutOffDay ?? null,
      payment_due_day: row.object.paymentDueDay ?? null,
      aval_cents: cents(row.object.aval),
    };
  });
  for (const chunk of chunked(records)) {
    await tx.execute(sql`
      insert into ${debtTerms} (account_id, debt_kind, annual_rate, minimum_payment_cents, minimum_payment_pct,
        credit_limit_cents, statement_cut_off_day, payment_due_day, aval_cents)
      select account_id, debt_kind, annual_rate, minimum_payment_cents, minimum_payment_pct,
        credit_limit_cents, statement_cut_off_day, payment_due_day, aval_cents
      from jsonb_to_recordset(${jsonbParam(chunk)}) as r(
        account_id uuid, debt_kind text, annual_rate numeric, minimum_payment_cents bigint, minimum_payment_pct numeric,
        credit_limit_cents bigint, statement_cut_off_day smallint, payment_due_day smallint, aval_cents bigint)
      on conflict (account_id) do update set
        debt_kind = excluded.debt_kind, annual_rate = excluded.annual_rate,
        minimum_payment_cents = excluded.minimum_payment_cents, minimum_payment_pct = excluded.minimum_payment_pct,
        credit_limit_cents = excluded.credit_limit_cents, statement_cut_off_day = excluded.statement_cut_off_day,
        payment_due_day = excluded.payment_due_day, aval_cents = excluded.aval_cents`);
  }
}

// A signed decimal figure in the integer minor units the ledger keeps; the sign stays its own.
function toSignedCents(figure: string | null): number | null {
  if (figure === null) return null;
  const negative = figure.trim().startsWith("-");
  const cents = toCents(figure.trim().replace(/^-/, ""));
  return negative ? -cents : cents;
}

// A statement already closed for an account's cut-off is final (RF-129): only new ones land.
async function commitStatements(
  tx: Transaction,
  rows: CommitRow<RestoredStatement>[],
  accountMap: Map<string, string>,
  placeholders: Set<string>,
): Promise<void> {
  const records = rows
    .filter((row) => row.status === "new")
    .map((row) => {
      const accountId = link(row.object.accountId, accountMap);
      assertLinked(accountId, placeholders);
      return {
        account_id: accountId,
        period_start: row.object.periodStart,
        cut_off_date: row.object.cutOffDate,
        payment_due_date: row.object.paymentDueDate,
        opening_balance_cents: toSignedCents(row.object.openingBalance),
        closing_balance_cents: toSignedCents(row.object.closingBalance),
        credits_cents: toSignedCents(row.object.credits),
        debits_cents: toSignedCents(row.object.debits),
        minimum_payment_cents: toSignedCents(row.object.minimumPayment),
        interest_charged_cents: toSignedCents(row.object.interestCharged),
        fees_charged_cents: toSignedCents(row.object.feesCharged),
        source: row.object.source,
      };
    });
  for (const chunk of chunked(records)) {
    await tx.execute(sql`
      insert into ${accountStatements} (account_id, period_start, cut_off_date, payment_due_date, opening_balance_cents,
        closing_balance_cents, credits_cents, debits_cents, minimum_payment_cents, interest_charged_cents,
        fees_charged_cents, source)
      select * from jsonb_to_recordset(${jsonbParam(chunk)}) as r(
        account_id uuid, period_start date, cut_off_date date, payment_due_date date, opening_balance_cents bigint,
        closing_balance_cents bigint, credits_cents bigint, debits_cents bigint, minimum_payment_cents bigint,
        interest_charged_cents bigint, fees_charged_cents bigint, source text)`);
  }
}

// Every movement's labels (RF-70), once all of them have landed: each one is found by the key it
// was written with, which every row carries (a blank one was keyed by its content upstream). An
// update already lost its old labels with its old splits, so this only ever adds.
async function commitTransactionLabels(
  tx: Transaction,
  rows: CommitRow<CreateTransactionInput>[],
  labelMap: Map<string, string>,
  placeholders: Set<string>,
  scope: CommitScope,
): Promise<void> {
  const links = rows.flatMap((row) =>
    row.object.labelIds.map((labelId) => {
      const linked = link(labelId, labelMap)!;
      assertLinked(linked, placeholders);
      return { external_ref: row.externalRef, label_id: linked };
    }),
  );
  for (const chunk of chunked(links)) {
    await tx.execute(sql`
      insert into ${transactionLabels} (transaction_id, label_id)
      select t.id, r.label_id
      from jsonb_to_recordset(${jsonbParam(chunk)}) as r(external_ref text, label_id uuid)
      join ${transactions} as t on t.external_ref = r.external_ref and ${inScope(scope)}`);
  }
}

// Reconciliation refusals a backup row can meet: the day, the opening, the latest count, an archived account.
const ADJUSTMENT_REFUSALS = new Set(["RC001", "RC002", "RC003", "RC004"]);

/**
 * Books each backup adjustment as the reconciliation that produces it (RF-137, RF-138), after
 * every ordinary movement has landed. The count is the account's balance that day plus the
 * exported gap, so the database books exactly that gap and the balance re-derives equal (RF-50).
 * In day order, since a reconciliation may not predate the account's latest. A row that already
 * exists in scope (`update`) is left alone: a reconciliation is final.
 */
async function commitAdjustments(
  tx: Transaction,
  rows: CommitRow<ImportedAdjustment>[],
  accountMap: Map<string, string>,
  placeholders: Set<string>,
): Promise<void> {
  const ordered = rows
    .filter((row) => row.status === "new")
    .sort((a, b) => a.object.occurredAt.localeCompare(b.object.occurredAt) || a.index - b.index);

  for (const row of ordered) {
    try {
      const accountId = link(row.object.accountId, accountMap)!;
      assertLinked(accountId, placeholders);
      const gap = toCents(row.object.amount) * (row.object.direction === "up" ? 1 : -1);

      await insertRow(tx, accountReconciliations, {
        accountId,
        reconciledOn: row.object.occurredAt,
        countedBalanceCents: sql`private.account_settlement_balance_on(${accountId}, ${row.object.occurredAt}::date) + ${gap}::bigint`,
        externalRef: row.externalRef,
      });
    } catch (error) {
      const code = pgErrorCode(error);
      const reasonKey =
        code !== undefined && ADJUSTMENT_REFUSALS.has(code)
          ? "data.import.errors.adjustmentRefused"
          : transactionReasonKey(error);
      throw rowFailure("transactions", row.sheetRow, reasonKey, error);
    }
  }
}
