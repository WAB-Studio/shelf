import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { reviseAccount } from "@/db/queries/account-write";
import { handAccountToGroup, listAccounts } from "@/db/queries/accounts";
import { freeCategoryColor, listScopedCategories, updateCategory } from "@/db/queries/categories";
import {
  bookMovement,
  categoryConstraintErrorKey,
  dropMovement,
  mergeMovements,
  moveCategoryMovements,
  openAccount,
  openCategory,
  reviseMovement,
} from "@/db/queries/ledger-write";
import {
  getTransactionById,
  listTransactions,
  type TransactionListFilters,
  type TransactionListRow,
  type TransactionSplitInput,
} from "@/db/queries/transactions";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { CATEGORY_COLORS } from "@/lib/fund/category-color";
import { ADD, ADD_ONCE, DESTROY, OVERWRITE, READ, previousFields, titled } from "@/lib/mcp/annotations";
import { categoryNameWarnings, movementWarnings, withWarnings, type Probe } from "@/lib/mcp/debt-guard";
import { resolveLabelIds } from "@/lib/mcp/label-tools";
import { parseForm } from "@/lib/mcp/parse-form";
import { centsToDecimal } from "@/lib/money";
import { ACCOUNT_KINDS, ACCOUNT_PLACEMENTS, ACCOUNT_SUBTYPES, createAccountSchema, updateAccountSchema } from "@/lib/validation/account";
import { createCategoryInputSchema, updateCategorySchema } from "@/lib/validation/category";
import {
  createTransactionSchema,
  descriptionSchema,
  HOUSEHOLD_MAKER,
  MOVEMENT_SEARCH_MAX,
  movementTypeFilter,
  occurredAtSchema,
  updateTransactionSchema,
} from "@/lib/validation/transaction";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

function movementShape(t: Say) {
  const d = (key: string) => t(`params.${key}`);
  const cents = z.number().int();
  return {
    fromAccountId: z.string().nullable().describe(d("fromAccountId")),
    toAccountId: z.string().nullable().describe(d("toAccountId")),
    amountCents: cents.describe(d("amountCents")),
    currency: z.string().optional().describe(d("currency")),
    counterAmountCents: cents.nullish().describe(d("counterAmountCents")),
    counterIsEstimate: z.boolean().optional().describe(d("counterIsEstimate")),
    occurredAt: z.string().describe(d("occurredAt")),
    description: z.string().nullable().describe(d("description")),
    categoryId: z.string().optional().describe(d("categoryId")),
    splits: z.array(z.object({ categoryId: z.string(), amountCents: cents, description: z.string().nullish() })).optional().describe(d("splits")),
    contributedByMemberId: z.string().nullish().describe(d("contributedByMemberId")),
    forHousehold: z.boolean().optional().describe(d("forHousehold")),
    madeByMemberId: z.string().nullish().describe(d("madeByMemberId")),
    labels: z.array(z.string()).optional().describe(d("labels")),
  };
}

type MovementInput = z.infer<z.ZodObject<ReturnType<typeof movementShape>>>;
type Split = TransactionSplitInput;

function movementForm(input: MovementInput) {
  const splits = input.splits ?? (input.categoryId ? [{ categoryId: input.categoryId, amountCents: input.amountCents }] : []);
  return {
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    amount: centsToDecimal(input.amountCents),
    currency: input.currency,
    counterAmount: input.counterAmountCents == null ? null : centsToDecimal(input.counterAmountCents),
    counterIsEstimate: input.counterIsEstimate,
    occurredAt: input.occurredAt,
    description: input.description,
    contributedByMemberId: input.contributedByMemberId,
    forHousehold: input.forHousehold,
    madeByMemberId: input.madeByMemberId,
    splits: splits.map((split: Split) => ({
      categoryId: split.categoryId,
      amount: centsToDecimal(split.amountCents),
      description: split.description,
    })),
    labelIds: [],
  };
}

// The lines an edit leaves the movement with, or undefined when the form should build them from `categoryId` alone.
// A transfer carries none; a lone line follows an amount that changed and keeps its name when its category does.
function splitsFor(current: TransactionListRow, patch: Partial<MovementInput>, amountCents: number, isTransfer: boolean): Split[] | undefined {
  if (patch.splits) return patch.splits;
  if (isTransfer) return undefined;
  const [only] = current.splits;
  if (current.splits.length === 1) {
    return [{ categoryId: patch.categoryId ?? only.categoryId, amountCents, description: only.description }];
  }
  return patch.categoryId ? undefined : current.splits;
}

// An edit sends what changes; what it omits is the stored row's, read back as the form would have loaded it.
function patched(current: TransactionListRow, patch: Partial<MovementInput>): MovementInput {
  const pick = <K extends keyof MovementInput>(key: K, stored: MovementInput[K]): MovementInput[K] =>
    patch[key] === undefined ? stored : (patch[key] as MovementInput[K]);
  const fromAccountId = pick("fromAccountId", current.fromAccountId);
  const toAccountId = pick("toAccountId", current.toAccountId);
  const amountCents = pick("amountCents", current.amountCents);
  const splits = splitsFor(current, patch, amountCents, fromAccountId !== null && toAccountId !== null);
  return {
    fromAccountId,
    toAccountId,
    amountCents,
    currency: pick("currency", current.currency),
    counterAmountCents: pick("counterAmountCents", current.counterAmountCents),
    counterIsEstimate: pick("counterIsEstimate", current.counterIsEstimate),
    occurredAt: pick("occurredAt", current.occurredAt),
    description: pick("description", current.description),
    categoryId: patch.categoryId,
    splits,
    contributedByMemberId: pick("contributedByMemberId", current.contributedByMemberId),
    forHousehold: pick("forHousehold", current.forHousehold),
    // Left absent when the patch names none: the edit keeps who made it while that still fits the movement.
    madeByMemberId: patch.madeByMemberId,
  };
}

const idOf = (key: string, value: string) => parseForm(z.uuid({ error: key }), value);

// The side a movement leaves open says its kind; a transfer is no expense or income, so it earns no warning.
function warningProbe(movement: MovementInput): Probe[] {
  const kind = movement.fromAccountId === null ? "income" : movement.toAccountId === null ? "expense" : null;
  const lines = movement.splits ?? (movement.categoryId ? [{ categoryId: movement.categoryId }] : []);
  return kind === null ? [] : [{ kind, description: movement.description, categoryIds: lines.map((line) => line.categoryId) }];
}

// The categories as list_categories answers them: parents and children in one flat list.
export async function categoryRows(owner: string) {
  return (await listScopedCategories(owner)).flatMap((parent) => [
    { id: parent.id, name: parent.name, kind: parent.kind, parentId: null, scope: parent.scope === "group" ? "fund" : "personal" },
    ...parent.children.map((child) => ({
      id: child.id,
      name: child.name,
      kind: parent.kind,
      parentId: parent.id,
      scope: parent.scope === "group" ? "fund" : "personal",
    })),
  ]);
}

export type MovementFilterInput = {
  accountId?: string;
  categoryId?: string;
  madeByMemberId?: string;
  label?: string;
  from?: string;
  to?: string;
  kind?: (typeof MOVEMENT_KINDS)[number];
  createdByUserId?: string;
  createdVia?: (typeof CREATED_VIA)[number];
  recurringRuleId?: string;
  q?: string;
};

const MOVEMENT_KINDS = ["expense", "income", "transfer", "adjustment"] as const;
// How a movement was written (RF-253): the web, Claude through the MCP, the Bandeja's accept, a statement or sheet import.
const CREATED_VIA = ["web", "mcp", "inbox", "import"] as const;

// The filters a listing and its totals take, the one set the Movimientos screen offers.
export function movementFilterShape(t: Say) {
  const d = (key: string) => t(`params.${key}`);
  return {
    accountId: z.string().optional().describe(d("accountId")),
    from: z.string().optional().describe(d("from")),
    to: z.string().optional().describe(d("to")),
    categoryId: z.string().optional().describe(d("filterCategoryId")),
    madeByMemberId: z.string().optional().describe(d("filterMadeByMemberId")),
    label: z.string().optional().describe(d("filterLabel")),
    kind: z.enum(MOVEMENT_KINDS).optional().describe(d("filterKind")),
    createdByUserId: z.string().optional().describe(d("filterCreatedBy")),
    createdVia: z.enum(CREATED_VIA).optional().describe(d("filterCreatedVia")),
    recurringRuleId: z.string().optional().describe(d("filterRecurringRule")),
    q: z.string().trim().min(1).max(MOVEMENT_SEARCH_MAX).optional().describe(d("filterQ")),
  };
}

// Each id is checked before it reaches a query, and a label named in words is read as the picker reads it.
export async function movementFilters(owner: string, input: MovementFilterInput): Promise<TransactionListFilters> {
  const accountId = input.accountId === undefined ? undefined : idOf("transactions.errors.accountInvalid", input.accountId);
  const categoryId = input.categoryId === undefined ? undefined : idOf("errors.notFound", input.categoryId);
  const madeByMemberId =
    input.madeByMemberId === undefined
      ? undefined
      : input.madeByMemberId === HOUSEHOLD_MAKER
        ? null
        : idOf("transactions.errors.madeByInvalid", input.madeByMemberId);
  const [labelId] = input.label === undefined ? [] : await resolveLabelIds(owner, [input.label]);
  return {
    accountId,
    categoryId,
    madeByMemberId,
    labelId,
    from: input.from,
    to: input.to,
    ...(input.kind === undefined ? {} : movementTypeFilter(input.kind)),
    memberUserId: input.createdByUserId === undefined ? undefined : idOf("errors.notFound", input.createdByUserId),
    createdVia: input.createdVia,
    recurringRuleId: input.recurringRuleId === undefined ? undefined : idOf("errors.notFound", input.recurringRuleId),
    search: input.q,
  };
}

// Everything update_movement can resend or patch, and the stamp it must quote back. A tool that removes
// a movement answers it in this shape, so record_movement can book it again.
export function movementRow(row: TransactionListRow) {
  return {
    id: row.id,
    kind: row.kind,
    date: row.occurredAt,
    description: row.description,
    amountCents: row.amountCents,
    currency: row.currency,
    counterAmountCents: row.counterAmountCents,
    counterIsEstimate: row.counterIsEstimate,
    fromAccountId: row.fromAccountId,
    toAccountId: row.toAccountId,
    contributedByMemberId: row.contributedByMemberId,
    forHousehold: row.forHousehold,
    madeByMemberId: row.madeByMemberId,
    madeByName: row.madeByName,
    // How it was written; null for what predates the column and for what a recurring rule or a reconciliation generated.
    createdVia: row.createdVia,
    labelIds: row.labels.map((label) => label.id),
    splits: row.splits,
    updatedAt: row.updatedAt,
  };
}

// A movement's stored fields under the names update_movement patches them by.
function storedMovement(row: TransactionListRow): Record<string, unknown> {
  return {
    fromAccountId: row.fromAccountId,
    toAccountId: row.toAccountId,
    amountCents: row.amountCents,
    currency: row.currency,
    counterAmountCents: row.counterAmountCents,
    counterIsEstimate: row.counterIsEstimate,
    occurredAt: row.occurredAt,
    description: row.description,
    splits: row.splits,
    contributedByMemberId: row.contributedByMemberId,
    forHousehold: row.forHousehold,
    madeByMemberId: row.madeByMemberId,
    labels: row.labels.map((label) => label.id),
  };
}

export function registerLedgerTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);
  const shape = movementShape(t);

  server.registerTool(
    "list_categories",
    { ...titled(t, "listCategories"), description: t("tools.listCategories"), inputSchema: z.object({}), annotations: READ },
    (_input, ctx) =>
      run(ctx, (owner) => categoryRows(owner)),
  );

  server.registerTool(
    "list_movements",
    {
      ...titled(t, "listMovements"),
      description: t("tools.listMovements"),
      inputSchema: z.object({
        ...movementFilterShape(t),
        limit: z.number().int().min(1).max(200).optional().describe(d("limit")),
        offset: z.number().int().min(0).optional().describe(d("offset")),
      }),
      annotations: READ,
    },
    (input: MovementFilterInput & { limit?: number; offset?: number }, ctx) =>
      run(ctx, async (owner) => {
        const rows = await listTransactions(await movementFilters(owner, input), { limit: input.limit ?? 50, offset: input.offset });
        return rows.map(movementRow);
      }),
  );

  server.registerTool(
    "record_movement",
    {
      ...titled(t, "recordMovement"),
      description: t("tools.recordMovement"),
      inputSchema: z.object({
        ...shape,
        requestRef: z.string().optional().describe(d("requestRef")),
        awaitingCounterparty: z.boolean().optional().describe(d("awaitingCounterparty")),
      }),
      annotations: ADD_ONCE,
    },
    (input: MovementInput & { requestRef?: string; awaitingCounterparty?: boolean }, ctx) =>
      run(ctx, async (owner) => {
        const booked = await bookMovement(
          parseForm(createTransactionSchema, {
            ...movementForm(input),
            labelIds: await resolveLabelIds(owner, input.labels ?? []),
            requestRef: input.requestRef,
          }),
          undefined,
          { awaitingCounterparty: input.awaitingCounterparty },
        );
        return withWarnings(booked, await movementWarnings(owner, warningProbe(input), t));
      }),
  );

  // The stamp is the one Claude read in list_movements: an edit after someone else's save is refused stale (RF-156).
  server.registerTool(
    "update_movement",
    {
      ...titled(t, "updateMovement"),
      description: t("tools.updateMovement"),
      inputSchema: z.object({
        transactionId: z.string().describe(d("transactionId")),
        expectedUpdatedAt: z.string().describe(d("expectedUpdatedAt")),
        ...z.object(shape).partial().shape,
      }),
      annotations: OVERWRITE,
    },
    (input: Partial<MovementInput> & { transactionId: string; expectedUpdatedAt: string }, ctx) =>
      run(ctx, async (owner) => {
        const { transactionId, expectedUpdatedAt, ...patch } = input;
        const id = idOf("errors.notFound", transactionId);
        const current = await getTransactionById(id);
        if (!current) throw new ActionError("errors.notFound");
        const merged = patched(current, patch);
        await reviseMovement(
          parseForm(updateTransactionSchema, {
            ...movementForm(merged),
            transactionId: id,
            // Absent keeps the movement's labels; a list replaces them, as the form's picker does.
            labelIds: patch.labels === undefined ? current.labels.map((label) => label.id) : await resolveLabelIds(owner, patch.labels),
            // An edit through this tool never moves the person it was for (RF-242).
            forPersonId: current.forPerson?.id ?? null,
            causedByTransactionId: current.causedByTransactionId,
            expectedUpdatedAt,
          }),
        );
        // A categoryId patch replaces the lines, so what it overwrote is the lines.
        const sent = { ...patch, splits: patch.splits ?? (patch.categoryId === undefined ? undefined : []) };
        // An edit that touches none of what the rules read warns of nothing, whatever the row already was.
        const reread = ["description", "categoryId", "splits", "fromAccountId", "toAccountId"].some((key) => patch[key as keyof typeof patch] !== undefined);
        const lines = merged.splits ?? current.splits;
        const warnings = reread ? await movementWarnings(owner, warningProbe({ ...merged, splits: lines }), t) : [];
        return withWarnings({ transactionId: id, before: previousFields(storedMovement(current), sent) }, warnings);
      }),
  );

  server.registerTool(
    "delete_movement",
    {
      ...titled(t, "deleteMovement"),
      description: t("tools.deleteMovement"),
      inputSchema: z.object({ transactionId: z.string().describe(d("transactionId")) }),
      annotations: DESTROY,
    },
    (input: { transactionId: string }, ctx) =>
      run(ctx, async () => {
        const id = idOf("errors.notFound", input.transactionId);
        const before = await getTransactionById(id);
        await dropMovement(id);
        return { transactionId: id, before: before === null ? null : movementRow(before) };
      }),
  );

  server.registerTool(
    "create_account",
    {
      ...titled(t, "createAccount"),
      description: t("tools.createAccount"),
      inputSchema: z.object({
        name: z.string().describe(d("accountName")),
        kind: z.enum(ACCOUNT_KINDS).describe(d("accountKind")),
        subtype: z.enum(ACCOUNT_SUBTYPES).describe(d("accountSubtype")),
        placement: z.enum(ACCOUNT_PLACEMENTS).default("personal").describe(d("accountPlacement")),
        settlementCurrency: z.string().default("COP").describe(d("settlementCurrency")),
        openingBalanceCents: z.number().int().describe(d("openingBalanceCents")),
        balanceOn: z.string().describe(d("balanceOn")),
        institution: z.string().nullable().default(null).describe(d("institution")),
        lastFour: z.string().optional().describe(d("lastFour")),
        parentAccountId: z.string().nullable().default(null).describe(d("parentAccountId")),
        holderMemberId: z.string().nullable().default(null).describe(d("holderMemberId")),
      }),
      annotations: ADD,
    },
    (input: Record<string, string | number | null | undefined>, ctx) =>
      run(ctx, async (owner) => {
        const { openingBalanceCents, ...rest } = input as { openingBalanceCents: number };
        return openAccount(parseForm(createAccountSchema, { ...rest, amount: centsToDecimal(openingBalanceCents) }), owner);
      }),
  );

  // The stamp is the one list_accounts returned; the edit goes through the dialog's schema and `updateAccount` (RF-172).
  server.registerTool(
    "update_account",
    {
      ...titled(t, "updateAccount"),
      description: t("tools.updateAccount"),
      inputSchema: z.object({
        accountId: z.string().describe(d("accountId")),
        expectedUpdatedAt: z.string().describe(d("expectedUpdatedAt")),
        name: z.string().optional().describe(d("accountName")),
        subtype: z.enum(ACCOUNT_SUBTYPES).optional().describe(d("accountSubtype")),
        settlementCurrency: z.string().optional().describe(d("settlementCurrency")),
        openingBalanceCents: z.number().int().optional().describe(d("openingBalanceCents")),
        balanceOn: z.string().optional().describe(d("balanceOn")),
        institution: z.string().nullable().optional().describe(d("institution")),
        lastFour: z.string().nullable().optional().describe(d("lastFour")),
        parentAccountId: z.string().nullable().optional().describe(d("parentAccountId")),
        holderMemberId: z.string().nullable().optional().describe(d("holderMemberId")),
      }),
      annotations: OVERWRITE,
    },
    (input: Record<string, string | number | null | undefined> & { accountId: string; expectedUpdatedAt: string }, ctx) =>
      run(ctx, async () => {
        const id = idOf("errors.notFound", input.accountId);
        const current = (await listAccounts({ archived: false })).find((account) => account.id === id);
        if (!current || !current.canWrite) throw new ActionError("errors.notFound");
        const pick = (key: string, stored: unknown) => (input[key] === undefined ? stored : input[key]);
        // The stored opening of a liability is negative; the form, and so Claude, speak what is owed, positive.
        const storedCents = current.kind === "liability" ? -current.initialBalanceCents : current.initialBalanceCents;
        await reviseAccount(parseForm(updateAccountSchema, {
          accountId: id,
          name: pick("name", current.name),
          kind: current.kind,
          subtype: pick("subtype", current.subtype),
          placement: current.ownerUserId ? "personal" : "group",
          isShared: current.isShared,
          institution: pick("institution", current.institution) ?? "",
          lastFour: pick("lastFour", current.lastFour) ?? undefined,
          parentAccountId: pick("parentAccountId", current.parentAccountId ?? null),
          holderMemberId: pick("holderMemberId", current.holderMemberId ?? null),
          settlementCurrency: pick("settlementCurrency", current.settlementCurrency),
          amount: centsToDecimal(input.openingBalanceCents === undefined ? storedCents : (input.openingBalanceCents as number)),
          balanceOn: pick("balanceOn", current.initialBalanceOn),
          expectedUpdatedAt: input.expectedUpdatedAt,
        }));
        return {
          accountId: id,
          before: previousFields(
            {
              name: current.name,
              subtype: current.subtype,
              settlementCurrency: current.settlementCurrency,
              openingBalanceCents: storedCents,
              balanceOn: current.initialBalanceOn,
              institution: current.institution,
              lastFour: current.lastFour,
              parentAccountId: current.parentAccountId,
              holderMemberId: current.holderMemberId,
            },
            input,
          ),
        };
      }),
  );

  // The same write as «Pasar al fondo»: the account keeps its id, balance, movements and pockets (RF-180).
  server.registerTool(
    "move_account_to_fund",
    {
      ...titled(t, "moveAccountToFund"),
      description: t("tools.moveAccountToFund"),
      inputSchema: z.object({ accountId: z.string().describe(d("accountId")) }),
      annotations: DESTROY,
    },
    (input: { accountId: string }, ctx) =>
      run(ctx, async () => {
        const id = idOf("errors.notFound", input.accountId);
        await handAccountToGroup({ accountId: id });
        return { accountId: id };
      }),
  );

  server.registerTool(
    "create_category",
    {
      ...titled(t, "createCategory"),
      description: t("tools.createCategory"),
      inputSchema: z.object({
        name: z.string().describe(d("categoryName")),
        kind: z.string().describe(d("categoryKind")),
        parentId: z.string().nullable().default(null).describe(d("parentId")),
        placement: z.string().optional().describe(d("categoryPlacement")),
        color: z.string().optional().describe(d("color")),
      }),
      annotations: ADD,
    },
    (input: { color?: string; placement?: string }, ctx) =>
      run(ctx, async (owner) => {
        const placement = input.placement === "personal" || input.placement === "group" ? input.placement : undefined;
        const color = input.color ?? (await freeCategoryColor(owner, placement));
        const form = parseForm(createCategoryInputSchema, { ...input, color });
        // The web allows any name, so a debt's or a saving's is written and warned of, not refused.
        return withWarnings(await openCategory(form, owner), categoryNameWarnings(form.name, t));
      }),
  );

  // Name, parent and colour go through the categories screen's schema and `updateCategory`; the kind never moves (RF-176).
  server.registerTool(
    "update_category",
    {
      ...titled(t, "updateCategory"),
      description: t("tools.updateCategory"),
      inputSchema: z.object({
        categoryId: z.string().describe(d("categoryRef")),
        name: z.string().optional().describe(d("categoryName")),
        parentId: z.string().nullable().optional().describe(d("parentId")),
        color: z.string().optional().describe(d("color")),
      }),
      annotations: OVERWRITE,
    },
    (input: { categoryId: string; name?: string; parentId?: string | null; color?: string }, ctx) =>
      run(ctx, async (owner) => {
        const id = idOf("errors.notFound", input.categoryId);
        const all = await categoryIndex(owner);
        const current = all.get(id);
        if (!current) throw new ActionError("errors.notFound");
        const parentId = input.parentId === undefined ? current.parentId : input.parentId;
        const parent = parentId === null ? undefined : all.get(parentId);
        if (parentId !== null && !parent) throw new ActionError("categories.errors.parentInvalid");
        if (parent && parent.kind !== current.kind) throw new ActionError("errors.categoryKindMismatch");
        const form = parseForm(updateCategorySchema, {
          categoryId: id,
          name: input.name ?? current.name,
          parentId,
          // Validated as a palette colour only when Claude sends one; a stored one is written back untouched.
          color: input.color ?? CATEGORY_COLORS[0],
        });
        let updated: boolean;
        try {
          updated = await updateCategory({ ...form, color: input.color ?? current.color });
        } catch (error) {
          if (pgErrorCode(error) === "42501") throw new ActionError("errors.notLeader");
          if (pgErrorCode(error) === "23514") throw new ActionError(categoryConstraintErrorKey(form.parentId));
          throw error;
        }
        if (!updated) throw new ActionError("errors.notFound");
        return { categoryId: id, before: previousFields({ name: current.name, parentId: current.parentId, color: current.color }, input) };
      }),
  );

  server.registerTool(
    "merge_movements",
    {
      ...titled(t, "mergeMovements"),
      description: t("tools.mergeMovements"),
      inputSchema: z.object({
        transactionIds: z.array(z.string()).min(2).max(50).describe(d("transactionIds")),
        description: z.string().nullable().optional().describe(d("description")),
        occurredAt: z.string().optional().describe(d("occurredAt")),
      }),
      annotations: DESTROY,
    },
    (input: { transactionIds: string[]; description?: string | null; occurredAt?: string }, ctx) =>
      run(ctx, async () => {
        const transactionIds = input.transactionIds.map((id) => idOf("errors.notFound", id));
        // The originals as list_movements shows them, read before they are deleted.
        const originals = await listTransactions({ ids: transactionIds }, { limit: transactionIds.length });
        const merged = await mergeMovements({
          transactionIds,
          description: parseForm(descriptionSchema, input.description ?? null) || null,
          occurredAt: input.occurredAt === undefined ? undefined : parseForm(occurredAtSchema, input.occurredAt),
        });
        return { ...merged, originals: originals.map(movementRow) };
      }),
  );

  server.registerTool(
    "move_category_movements",
    {
      ...titled(t, "moveCategoryMovements"),
      description: t("tools.moveCategoryMovements"),
      inputSchema: z.object({
        fromCategoryId: z.string().describe(d("fromCategoryId")),
        toCategoryId: z.string().describe(d("toCategoryId")),
        from: z.string().optional().describe(d("from")),
        to: z.string().optional().describe(d("to")),
        dryRun: z.boolean().optional().describe(d("dryRun")),
        expectedCount: z.number().int().min(1).optional().describe(d("expectedCount")),
      }),
      annotations: OVERWRITE,
    },
    (input: { fromCategoryId: string; toCategoryId: string; from?: string; to?: string; dryRun?: boolean; expectedCount?: number }, ctx) =>
      run(ctx, async (owner) => {
        const fromCategoryId = idOf("errors.notFound", input.fromCategoryId);
        const toCategoryId = idOf("errors.notFound", input.toCategoryId);
        const all = await categoryIndex(owner);
        const [source, target] = [all.get(fromCategoryId), all.get(toCategoryId)];
        if (!source || !target || fromCategoryId === toCategoryId) throw new ActionError("errors.notFound");
        if (source.kind !== target.kind) throw new ActionError("errors.categoryKindMismatch");
        const day = z.iso.date({ error: "errors.unexpected" }).optional();
        // Q3 of the parity plan: a write moves only the count a dry run gave, so the person's yes covers what moves.
        if (!input.dryRun && input.expectedCount === undefined) throw new ActionError("mcp.errors.moveNeedsCount");
        const moved = await moveCategoryMovements({
          fromCategoryId,
          toCategoryId,
          from: parseForm(day, input.from),
          to: parseForm(day, input.to),
          dryRun: input.dryRun,
          expectedCount: input.dryRun ? undefined : input.expectedCount,
        });
        if (!input.dryRun && moved.moved === 0) throw new ActionError("mcp.errors.moveCountChanged");
        return { ...moved, fromCategoryId, toCategoryId };
      }),
  );
}

type CategoryRow = { name: string; kind: "expense" | "income"; color: string | null; parentId: string | null };

// Every category the person can see by id, a subcategory carrying its parent's kind.
async function categoryIndex(owner: string): Promise<Map<string, CategoryRow>> {
  const index = new Map<string, CategoryRow>();
  for (const parent of await listScopedCategories(owner)) {
    index.set(parent.id, { name: parent.name, kind: parent.kind, color: parent.color, parentId: null });
    for (const child of parent.children) {
      index.set(child.id, { name: child.name, kind: parent.kind, color: child.color, parentId: parent.id });
    }
  }
  return index;
}
