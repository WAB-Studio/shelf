import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { listAccounts, updateAccount } from "@/db/queries/accounts";
import { freeCategoryColor, listScopedCategories } from "@/db/queries/categories";
import { bookMovement, dropMovement, openAccount, openCategory, reviseMovement } from "@/db/queries/ledger-write";
import { getTransactionById, listTransactions, type TransactionListRow, type TransactionSplitInput } from "@/db/queries/transactions";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { centsToDecimal, parseAmount } from "@/lib/money";
import { createAccountSchema, updateAccountSchema } from "@/lib/validation/account";
import { createCategoryInputSchema } from "@/lib/validation/category";
import { createTransactionSchema, updateTransactionSchema } from "@/lib/validation/transaction";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

// Claude speaks integer cents; the forms' schemas read the decimal text a person types. The text is
// built from the integer, so the schema then judges it exactly as it judges a form (RNF-10).
function parseForm<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const verdict = schema.safeParse(data);
  if (!verdict.success) throw new ActionError(verdict.error.issues[0].message);
  return verdict.data;
}

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
        limit: z.number().int().min(1).max(200).optional().describe(d("limit")),
      }),
      annotations: { readOnlyHint: true },
    },
    (input: { accountId?: string; from?: string; to?: string; limit?: number }, ctx) =>
      run(ctx, async () => {
        const accountId = input.accountId === undefined ? undefined : idOf("transactions.errors.accountInvalid", input.accountId);
        const rows = await listTransactions({ accountId, from: input.from, to: input.to }, { limit: input.limit ?? 50 });
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
      run(ctx, async () =>
        bookMovement(parseForm(createTransactionSchema, { ...movementForm(input), requestRef: input.requestRef })),
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
      run(ctx, async () => {
        const { transactionId, expectedUpdatedAt, ...patch } = input;
        const id = idOf("errors.notFound", transactionId);
        const current = await getTransactionById(id);
        if (!current) throw new ActionError("errors.notFound");
        await reviseMovement(
          parseForm(updateTransactionSchema, {
            ...movementForm(patched(current, patch)),
            transactionId: id,
            labelIds: current.labels.map((label) => label.id),
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
}
