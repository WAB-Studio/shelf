import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import {
  accountReconciliations,
  accounts,
  categories,
  groupMembers,
  recurringRules,
  transactionLabels,
  transactionSplits,
  transactions,
} from "@/db/schema";
import type { Transaction } from "@/db/session";
import { BASE_CURRENCY } from "@/lib/currency";
import { insertRow } from "@/db/insert-row";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { parseAmount } from "@/lib/money";
import type { SheetEntity } from "@/lib/spreadsheet/schema";
import type { CreateAccountInput } from "@/lib/validation/account";
import type { ImportedAdjustment } from "@/lib/validation/account-reconciliation";
import type { CreateCategoryInput } from "@/lib/validation/category";
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
// insert unless blank. `placeholderId` is set only for a NEW account or category,
// so a reference to it remaps to its REAL inserted id. `object` is the entity's
// `createXSchema` payload.
export type CommitRow<T> = {
  index: number;
  sheetRow: number;
  status: "new" | "update";
  externalRef: string | null;
  placeholderId: string | null;
  object: T;
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

// `assert_split_matches_transaction` and its neighbours raise these; the preview
// already refuses a category/direction mismatch before a commit ever reaches here
// (RF-27), so this is the net under a race the preview could not see — a category
// or account edited or removed between preview and confirm. Mirrors
// `mapTransactionError` in the live create action, minus the throw: this caller
// still has a row index to attach to whichever reason wins.
const CURRENCY_REFUSAL = "23901";

function transactionReasonKey(error: unknown): string {
  const code = pgErrorCode(error);
  if (code === "42501") return "errors.notFound";
  if (code === CURRENCY_REFUSAL) return "transactions.errors.currencyMismatch";
  if (code === "23514") return "transactions.errors.splitsScopeViolation";
  if (code === "23503") return "errors.referenceGone";
  return "errors.unexpected";
}

// The whole file's passing rows, in the five entity buckets the pipeline produced. The
// commit walks them in dependency order (RF-51): members and categories, then accounts,
// then recurring rules and transactions.
export type CommitInput = {
  members: CommitRow<CreateMemberInput>[];
  categories: CommitRow<CreateCategoryInput>[];
  accounts: CommitRow<CreateAccountInput>[];
  recurringRules: CommitRow<CreateRecurringRuleInput>[];
  transactions: CommitRow<CreateTransactionInput>[];
  // A backup's reconciliation adjustments (RF-50): booked as reconciliations, never as movements.
  adjustments?: CommitRow<ImportedAdjustment>[];
};

export type CommitOutcome = { inserted: number; updated: number };

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

/**
 * Write the whole import in ONE caller-supplied transaction (RF-51): every insert and
 * update runs against `tx`, so a single failure rolls back ALL of it and the audit
 * trigger captures each write (RF-45). Rows classified `new` insert; rows classified
 * `update` overwrite the existing row by its `external_ref` within scope (RF-52). A
 * reference to a file-new account or category resolves to that entity's REAL inserted
 * id through the placeholder maps built as the accounts and categories land — never the
 * pipeline's placeholder. The caller opens the transaction (`withUserDb`) and settles the
 * session; this function only writes.
 */
export async function commitImport(
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

  // Then accounts, so a movement or rule that names one can link to its real id.
  const accountMap = await commitAccounts(tx, input.accounts, scope);

  // Reject before a single recurring rule or transaction lands (RF-121):
  // `toCents` below still reads every amount as pesos, which only an account
  // settling in BASE_CURRENCY makes correct.
  await assertBaseCurrencyAccounts(
    tx,
    [
      ...input.recurringRules.map((row) => row.object),
      ...input.transactions.map((row) => row.object),
    ],
    accountMap,
  );

  // The placeholders any reference could still be carrying: the union of every file-new
  // account and category. After remap, no written reference may be one of these.
  const placeholders = new Set<string>([...accountMap.keys(), ...categoryMap.keys()]);

  await commitRecurringRules(tx, input.recurringRules, accountMap, categoryMap, placeholders);
  await commitTransactions(tx, input.transactions, accountMap, categoryMap, placeholders);

  await commitAdjustments(tx, input.adjustments ?? [], accountMap, placeholders);

  for (const bucket of [
    input.members,
    input.categories,
    input.accounts,
    input.recurringRules,
    input.transactions,
    input.adjustments ?? [],
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

  for (const row of rows) {
    if (row.status !== "update") continue;
    await tx
      .update(groupMembers)
      .set({ name: row.object.name, inviteEmail: row.object.email ?? null })
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.externalRef, row.externalRef!)));
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

  for (const row of rows) {
    if (row.status !== "update") continue;
    const parentId = row.object.parentId === null ? null : map.get(row.object.parentId) ?? row.object.parentId;
    await tx
      .update(categories)
      .set({ name: row.object.name, parentId, color: row.object.color })
      .where(
        and(
          eq(categories.externalRef, row.externalRef!),
          groupId ? eq(categories.groupId, groupId) : eq(categories.ownerUserId, scope.userId),
        ),
      );
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
          row.externalRef,
        ];
      }),
    );
    newRows.forEach((row, index) => {
      if (row.placeholderId) map.set(row.placeholderId, inserted[index].id);
    });
  }

  for (const row of rows) {
    if (row.status !== "update") continue;
    const scoped = placementColumns(row.object.placement);
    const cents = toCents(row.object.amount);
    await tx
      .update(accounts)
      .set({
        name: row.object.name,
        subtype: row.object.subtype,
        isShared: scoped.isShared,
        institution: row.object.institution,
        initialBalanceCents: row.object.kind === "liability" ? -cents : cents,
        initialBalanceOn: row.object.balanceOn,
      })
      .where(
        and(
          eq(accounts.externalRef, row.externalRef!),
          scoped.groupId
            ? eq(accounts.groupId, scoped.groupId)
            : eq(accounts.ownerUserId, scope.userId),
        ),
      );
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
// read back in one round trip now that a file-new account has a real row (RF-121). A
// file-new account is never foreign here — `commitAccounts` writes none of them a
// settlement currency of their own, so the column default (BASE_CURRENCY) holds — but
// the check still walks it like any other, per row, and stops at the first mismatch.
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

  for (const row of rows) {
    if (row.status !== "update") continue;
    const linked = resolve(row.object);
    await tx
      .update(recurringRules)
      .set({
        fromAccountId: linked.fromAccountId,
        toAccountId: linked.toAccountId,
        amountCents: toCents(row.object.amount),
        categoryId: linked.categoryId,
        description: row.object.description ?? null,
        frequency: row.object.frequency,
        intervalN: row.object.intervalN,
        dayOfMonth: row.object.dayOfMonth ?? null,
        nextRunOn: row.object.nextRunOn,
        endsOn: row.object.endsOn ?? null,
      })
      .where(eq(recurringRules.externalRef, row.externalRef!));
  }
}

// A new row's write, resolved once: the real account and category ids a placeholder
// stood for, the cents its amount and splits parse to. Shared by the batch attempt
// and the serial fallback so the two write the exact same values.
type ResolvedNewTransaction = {
  row: CommitRow<CreateTransactionInput>;
  fromAccountId: string | null;
  toAccountId: string | null;
  amountCents: number;
  splits: { categoryId: string; amountCents: number }[];
};

function resolveNewTransaction(
  row: CommitRow<CreateTransactionInput>,
  accountMap: Map<string, string>,
  categoryMap: Map<string, string>,
  placeholders: Set<string>,
): ResolvedNewTransaction {
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

  return { row, fromAccountId, toAccountId, amountCents: toCents(object.amount), splits };
}

// Transactions carry a child split, so a new row writes the movement then its splits,
// and an update overwrites the row and replaces the split wholesale (delete + insert),
// mirroring `updateTransaction`. New rows batch (RNF-15); an update stays serial, same
// as every other entity's update path here.
async function commitTransactions(
  tx: Transaction,
  rows: CommitRow<CreateTransactionInput>[],
  accountMap: Map<string, string>,
  categoryMap: Map<string, string>,
  placeholders: Set<string>,
): Promise<void> {
  const newRows = rows.filter((row) => row.status === "new");
  const updateRows = rows.filter((row) => row.status === "update");

  await commitNewTransactions(tx, newRows, accountMap, categoryMap, placeholders);

  for (const row of updateRows) {
    try {
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
      const amountCents = toCents(object.amount);

      const [updated] = await tx
        .update(transactions)
        .set({
          fromAccountId,
          toAccountId,
          amountCents,
          occurredAt: object.occurredAt,
          description: object.description,
          // Mirrors `updateTransaction`: correcting a generated, unreviewed movement also
          // confirms it, while a manual or already-reviewed row's stamp stays put (RF-31).
          reviewedAt: sql`case when ${transactions.recurringRuleId} is not null and ${transactions.reviewedAt} is null then now() else ${transactions.reviewedAt} end`,
        })
        .where(eq(transactions.externalRef, row.externalRef!))
        .returning({ id: transactions.id });

      if (!updated) continue;
      await tx.delete(transactionSplits).where(eq(transactionSplits.transactionId, updated.id));
      await tx.delete(transactionLabels).where(eq(transactionLabels.transactionId, updated.id));
      await writeSplits(tx, updated.id, splits);
    } catch (error) {
      // Named here and nowhere upstream: `withUserDb` rolls the whole write back on
      // this throw, and every row already inserted goes with it (RF-51) — the same
      // all-or-nothing the preview promised, minus the three minutes of guessing
      // which row it was.
      throw rowFailure("transactions", row.sheetRow, transactionReasonKey(error), error);
    }
  }
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

  const resolved: ResolvedNewTransaction[] = [];
  for (const row of rows) {
    try {
      resolved.push(resolveNewTransaction(row, accountMap, categoryMap, placeholders));
    } catch (error) {
      throw rowFailure("transactions", row.sheetRow, transactionReasonKey(error), error);
    }
  }

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
  chunk: ResolvedNewTransaction[],
): Promise<void> {
  const rowValues = sql.join(
    chunk.map(
      (item) =>
        sql`(${item.fromAccountId}, ${item.toAccountId}, ${item.amountCents},
          ${item.row.object.occurredAt}, ${item.row.object.description}, ${item.row.externalRef})`,
    ),
    sql`, `,
  );
  const inserted = (await tx.execute(
    sql`insert into ${transactions}
      (from_account_id, to_account_id, amount_cents, occurred_at, description, external_ref)
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
  rows: ResolvedNewTransaction[],
): Promise<void> {
  for (const item of rows) {
    try {
      const [inserted] = (await tx.execute(
        sql`insert into ${transactions}
          (from_account_id, to_account_id, amount_cents, occurred_at, description, external_ref)
          values (${item.fromAccountId}, ${item.toAccountId}, ${item.amountCents},
            ${item.row.object.occurredAt}, ${item.row.object.description}, ${item.row.externalRef})
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
