import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { handAccountToGroup, listAccounts, updateAccount } from "@/db/queries/accounts";
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
import { getTransactionById, listTransactions, type TransactionListRow, type TransactionSplitInput } from "@/db/queries/transactions";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { CATEGORY_COLORS } from "@/lib/fund/category-color";
import { resolveLabelIds } from "@/lib/mcp/label-tools";
import { parseForm } from "@/lib/mcp/parse-form";
import { centsToDecimal, parseAmount } from "@/lib/money";
import { createAccountSchema, updateAccountSchema } from "@/lib/validation/account";
import { createCategoryInputSchema, updateCategorySchema } from "@/lib/validation/category";
import { createTransactionSchema, descriptionSchema, HOUSEHOLD_MAKER, occurredAtSchema, updateTransactionSchema } from "@/lib/validation/transaction";

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

export function registerLedgerTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
  const shape = movementShape(t);
  const idOf = (key: string, value: string) => parseForm(z.uuid({ error: key }), value);

  server.registerTool(
    "list_categories",
    { description: t("tools.listCategories"), inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    (_input, ctx) =>
      run(ctx, async (owner) =>
        (await listScopedCategories(owner)).flatMap((parent) => [
          { id: parent.id, name: parent.name, kind: parent.kind, parentId: null, scope: parent.scope === "group" ? "fund" : "personal" },
          ...parent.children.map((child) => ({
            id: child.id,
            name: child.name,
            kind: parent.kind,
            parentId: parent.id,
            scope: parent.scope === "group" ? "fund" : "personal",
          })),
        ]),
      ),
  );

  server.registerTool(
    "list_movements",
    {
      description: t("tools.listMovements"),
      inputSchema: z.object({
        accountId: z.string().optional().describe(d("accountId")),
        from: z.string().optional().describe(d("from")),
        to: z.string().optional().describe(d("to")),
        categoryId: z.string().optional().describe(d("filterCategoryId")),
        madeByMemberId: z.string().optional().describe(d("filterMadeByMemberId")),
        label: z.string().optional().describe(d("filterLabel")),
        limit: z.number().int().min(1).max(200).optional().describe(d("limit")),
        offset: z.number().int().min(0).optional().describe(d("offset")),
      }),
      annotations: { readOnlyHint: true },
    },
    (input: { accountId?: string; categoryId?: string; madeByMemberId?: string; label?: string; from?: string; to?: string; limit?: number; offset?: number }, ctx) =>
      run(ctx, async (owner) => {
        const accountId = input.accountId === undefined ? undefined : idOf("transactions.errors.accountInvalid", input.accountId);
        const categoryId = input.categoryId === undefined ? undefined : idOf("errors.notFound", input.categoryId);
        const madeByMemberId =
          input.madeByMemberId === undefined
            ? undefined
            : input.madeByMemberId === HOUSEHOLD_MAKER
              ? null
              : idOf("transactions.errors.madeByInvalid", input.madeByMemberId);
        const [labelId] = input.label === undefined ? [] : await resolveLabelIds(owner, [input.label]);
        const rows = await listTransactions(
          { accountId, categoryId, madeByMemberId, labelId, from: input.from, to: input.to },
          { limit: input.limit ?? 50, offset: input.offset },
        );
        // Everything update_movement can resend or patch, and the stamp it must quote back.
        return rows.map((row) => ({
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
          labelIds: row.labels.map((label) => label.id),
          splits: row.splits,
          updatedAt: row.updatedAt,
        }));
      }),
  );

  server.registerTool(
    "record_movement",
    {
      description: t("tools.recordMovement"),
      inputSchema: z.object({ ...shape, requestRef: z.string().optional().describe(d("requestRef")) }),
      annotations: { ...write, idempotentHint: true },
    },
    (input: MovementInput & { requestRef?: string }, ctx) =>
      run(ctx, async (owner) =>
        bookMovement(
          parseForm(createTransactionSchema, {
            ...movementForm(input),
            labelIds: await resolveLabelIds(owner, input.labels ?? []),
            requestRef: input.requestRef,
          }),
        ),
      ),
  );

  // The stamp is the one Claude read in list_movements: an edit after someone else's save is refused stale (RF-156).
  server.registerTool(
    "update_movement",
    {
      description: t("tools.updateMovement"),
      inputSchema: z.object({
        transactionId: z.string().describe(d("transactionId")),
        expectedUpdatedAt: z.string().describe(d("expectedUpdatedAt")),
        ...z.object(shape).partial().shape,
      }),
      annotations: { ...write, idempotentHint: true },
    },
    (input: Partial<MovementInput> & { transactionId: string; expectedUpdatedAt: string }, ctx) =>
      run(ctx, async (owner) => {
        const { transactionId, expectedUpdatedAt, ...patch } = input;
        const id = idOf("errors.notFound", transactionId);
        const current = await getTransactionById(id);
        if (!current) throw new ActionError("errors.notFound");
        await reviseMovement(
          parseForm(updateTransactionSchema, {
            ...movementForm(patched(current, patch)),
            transactionId: id,
            // Absent keeps the movement's labels; a list replaces them, as the form's picker does.
            labelIds: patch.labels === undefined ? current.labels.map((label) => label.id) : await resolveLabelIds(owner, patch.labels),
            causedByTransactionId: current.causedByTransactionId,
            expectedUpdatedAt,
          }),
        );
        return { transactionId: id };
      }),
  );

  server.registerTool(
    "delete_movement",
    {
      description: t("tools.deleteMovement"),
      inputSchema: z.object({ transactionId: z.string().describe(d("transactionId")) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    (input: { transactionId: string }, ctx) =>
      run(ctx, async () => {
        const id = idOf("errors.notFound", input.transactionId);
        await dropMovement(id);
        return { transactionId: id };
      }),
  );

  server.registerTool(
    "create_account",
    {
      description: t("tools.createAccount"),
      inputSchema: z.object({
        name: z.string().describe(d("accountName")),
        kind: z.string().describe(d("accountKind")),
        subtype: z.string().describe(d("accountSubtype")),
        placement: z.string().default("personal").describe(d("accountPlacement")),
        settlementCurrency: z.string().default("COP").describe(d("settlementCurrency")),
        openingBalanceCents: z.number().int().describe(d("openingBalanceCents")),
        balanceOn: z.string().describe(d("balanceOn")),
        institution: z.string().nullable().default(null).describe(d("institution")),
        lastFour: z.string().optional().describe(d("lastFour")),
        parentAccountId: z.string().nullable().default(null).describe(d("parentAccountId")),
        holderMemberId: z.string().nullable().default(null).describe(d("holderMemberId")),
      }),
      annotations: write,
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
      description: t("tools.updateAccount"),
      inputSchema: z.object({
        accountId: z.string().describe(d("accountId")),
        expectedUpdatedAt: z.string().describe(d("expectedUpdatedAt")),
        name: z.string().optional().describe(d("accountName")),
        subtype: z.string().optional().describe(d("accountSubtype")),
        settlementCurrency: z.string().optional().describe(d("settlementCurrency")),
        openingBalanceCents: z.number().int().optional().describe(d("openingBalanceCents")),
        balanceOn: z.string().optional().describe(d("balanceOn")),
        institution: z.string().nullable().optional().describe(d("institution")),
        lastFour: z.string().nullable().optional().describe(d("lastFour")),
        parentAccountId: z.string().nullable().optional().describe(d("parentAccountId")),
        holderMemberId: z.string().nullable().optional().describe(d("holderMemberId")),
      }),
      annotations: { ...write, idempotentHint: true },
    },
    (input: Record<string, string | number | null | undefined> & { accountId: string; expectedUpdatedAt: string }, ctx) =>
      run(ctx, async () => {
        const id = idOf("errors.notFound", input.accountId);
        const current = (await listAccounts({ archived: false })).find((account) => account.id === id);
        if (!current || !current.canWrite) throw new ActionError("errors.notFound");
        const pick = (key: string, stored: unknown) => (input[key] === undefined ? stored : input[key]);
        // The stored opening of a liability is negative; the form, and so Claude, speak what is owed, positive.
        const storedCents = current.kind === "liability" ? -current.initialBalanceCents : current.initialBalanceCents;
        const { amount, ...form } = parseForm(updateAccountSchema, {
          accountId: id,
          name: pick("name", current.name),
          kind: current.kind,
          subtype: pick("subtype", current.subtype),
          isShared: current.isShared,
          institution: pick("institution", current.institution) ?? "",
          lastFour: pick("lastFour", current.lastFour) ?? undefined,
          parentAccountId: pick("parentAccountId", current.parentAccountId ?? null),
          holderMemberId: pick("holderMemberId", current.holderMemberId ?? null),
          settlementCurrency: pick("settlementCurrency", current.settlementCurrency),
          amount: centsToDecimal(input.openingBalanceCents === undefined ? storedCents : (input.openingBalanceCents as number)),
          balanceOn: pick("balanceOn", current.initialBalanceOn),
          expectedUpdatedAt: input.expectedUpdatedAt,
        });
        const amountMinor = parseAmount(amount);
        if (amountMinor === null) throw new ActionError("errors.unexpected");
        let updated: Awaited<ReturnType<typeof updateAccount>>;
        try {
          updated = await updateAccount({ ...form, expectedUpdatedAt: form.expectedUpdatedAt ?? input.expectedUpdatedAt, amountMinor });
        } catch (error) {
          if (pgErrorCode(error) === "42501") throw new ActionError("errors.notLeader");
          if (pgErrorCode(error) === "23514") throw new ActionError("accounts.errors.currencyInvalid");
          if (pgErrorCode(error) === "AC001") throw new ActionError("accounts.errors.currencyLocked");
          if (pgErrorCode(error) === "PK001") throw new ActionError("accounts.errors.parentInvalid");
          if (pgErrorCode(error) === "PK002") throw new ActionError("accounts.errors.hasPockets");
          throw error;
        }
        if (updated === "stale") throw new ActionError("errors.stale");
        if (!updated) throw new ActionError("errors.notFound");
        return { accountId: id };
      }),
  );

  // The same write as «Pasar al fondo»: the account keeps its id, balance, movements and pockets (RF-180).
  server.registerTool(
    "move_account_to_fund",
    {
      description: t("tools.moveAccountToFund"),
      inputSchema: z.object({ accountId: z.string().describe(d("accountId")) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
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
      description: t("tools.createCategory"),
      inputSchema: z.object({
        name: z.string().describe(d("categoryName")),
        kind: z.string().describe(d("categoryKind")),
        parentId: z.string().nullable().default(null).describe(d("parentId")),
        placement: z.string().optional().describe(d("categoryPlacement")),
        color: z.string().optional().describe(d("color")),
      }),
      annotations: write,
    },
    (input: { color?: string; placement?: string }, ctx) =>
      run(ctx, async (owner) => {
        const placement = input.placement === "personal" || input.placement === "group" ? input.placement : undefined;
        const color = input.color ?? (await freeCategoryColor(owner, placement));
        return openCategory(parseForm(createCategoryInputSchema, { ...input, color }), owner);
      }),
  );

  // Name, parent and colour go through the categories screen's schema and `updateCategory`; the kind never moves (RF-176).
  server.registerTool(
    "update_category",
    {
      description: t("tools.updateCategory"),
      inputSchema: z.object({
        categoryId: z.string().describe(d("categoryRef")),
        name: z.string().optional().describe(d("categoryName")),
        parentId: z.string().nullable().optional().describe(d("parentId")),
        color: z.string().optional().describe(d("color")),
      }),
      annotations: { ...write, idempotentHint: true },
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
        return { categoryId: id };
      }),
  );

  server.registerTool(
    "merge_movements",
    {
      description: t("tools.mergeMovements"),
      inputSchema: z.object({
        transactionIds: z.array(z.string()).min(2).max(50).describe(d("transactionIds")),
        description: z.string().nullable().optional().describe(d("description")),
        occurredAt: z.string().optional().describe(d("occurredAt")),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    (input: { transactionIds: string[]; description?: string | null; occurredAt?: string }, ctx) =>
      run(ctx, async () =>
        mergeMovements({
          transactionIds: input.transactionIds.map((id) => idOf("errors.notFound", id)),
          description: parseForm(descriptionSchema, input.description ?? null) || null,
          occurredAt: input.occurredAt === undefined ? undefined : parseForm(occurredAtSchema, input.occurredAt),
        }),
      ),
  );

  server.registerTool(
    "move_category_movements",
    {
      description: t("tools.moveCategoryMovements"),
      inputSchema: z.object({
        fromCategoryId: z.string().describe(d("fromCategoryId")),
        toCategoryId: z.string().describe(d("toCategoryId")),
        from: z.string().optional().describe(d("from")),
        to: z.string().optional().describe(d("to")),
        dryRun: z.boolean().optional().describe(d("dryRun")),
      }),
      annotations: { ...write, idempotentHint: true },
    },
    (input: { fromCategoryId: string; toCategoryId: string; from?: string; to?: string; dryRun?: boolean }, ctx) =>
      run(ctx, async (owner) => {
        const fromCategoryId = idOf("errors.notFound", input.fromCategoryId);
        const toCategoryId = idOf("errors.notFound", input.toCategoryId);
        const all = await categoryIndex(owner);
        const [source, target] = [all.get(fromCategoryId), all.get(toCategoryId)];
        if (!source || !target || fromCategoryId === toCategoryId) throw new ActionError("errors.notFound");
        if (source.kind !== target.kind) throw new ActionError("errors.categoryKindMismatch");
        const day = z.iso.date({ error: "errors.unexpected" }).optional();
        return moveCategoryMovements({
          fromCategoryId,
          toCategoryId,
          from: parseForm(day, input.from),
          to: parseForm(day, input.to),
          dryRun: input.dryRun,
        });
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
