import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { listScopedCategories } from "@/db/queries/categories";
import { bookMovement, dropMovement, openAccount, openCategory, reviseMovement } from "@/db/queries/ledger-write";
import { getTransactionById, listTransactions } from "@/db/queries/transactions";
import { ActionError } from "@/lib/errors";
import { CATEGORY_COLORS, nextCategoryColor } from "@/lib/fund/category-color";
import { centsToDecimal } from "@/lib/money";
import { createAccountSchema } from "@/lib/validation/account";
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

const cents = z.number().int();
const date = z.string().describe("AAAA-MM-DD");

const movementShape = {
  fromAccountId: z.string().nullable().describe("Cuenta de origen: null en un ingreso."),
  toAccountId: z.string().nullable().describe("Cuenta de destino: null en un gasto."),
  amountCents: cents.describe("Monto en centavos enteros."),
  currency: z.string().optional().describe("COP o USD; si falta, la de las cuentas."),
  counterAmountCents: cents.nullish().describe("Lo que salió o llegó en la cuenta de otra moneda."),
  occurredAt: date,
  description: z.string().nullable(),
  categoryId: z.string().optional().describe("Atajo: una sola categoría por todo el monto."),
  splits: z.array(z.object({ categoryId: z.string(), amountCents: cents })).optional(),
  contributedByMemberId: z.string().nullish().describe("«De quién»: obligatorio en un ingreso a una cuenta del fondo."),
  forHousehold: z.boolean().optional(),
};

type MovementInput = z.infer<z.ZodObject<typeof movementShape>>;

function movementForm(input: MovementInput) {
  const splits = input.splits ?? (input.categoryId ? [{ categoryId: input.categoryId, amountCents: input.amountCents }] : []);
  return {
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    amount: centsToDecimal(input.amountCents),
    currency: input.currency,
    counterAmount: input.counterAmountCents == null ? null : centsToDecimal(input.counterAmountCents),
    occurredAt: input.occurredAt,
    description: input.description,
    contributedByMemberId: input.contributedByMemberId,
    forHousehold: input.forHousehold,
    splits: splits.map((split) => ({ categoryId: split.categoryId, amount: centsToDecimal(split.amountCents) })),
    labelIds: [],
  };
}

export function registerLedgerTools(server: McpServer, run: Run, t: Say): void {
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };

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
        accountId: z.string().uuid().optional(),
        from: date.regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: date.regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    (input: { accountId?: string; from?: string; to?: string; limit?: number }, ctx) =>
      run(ctx, async () =>
        (await listTransactions({ accountId: input.accountId, from: input.from, to: input.to }, { limit: input.limit ?? 50 })).map(
          (row) => ({
            id: row.id,
            kind: row.kind,
            date: row.occurredAt,
            description: row.description,
            amountCents: row.amountCents,
            currency: row.currency,
            fromAccountId: row.fromAccountId,
            toAccountId: row.toAccountId,
            splits: row.splits,
          }),
        ),
      ),
  );

  server.registerTool(
    "record_movement",
    { description: t("tools.recordMovement"), inputSchema: z.object(movementShape), annotations: write },
    (input: MovementInput, ctx) =>
      run(ctx, async () => bookMovement(parseForm(createTransactionSchema, movementForm(input)))),
  );

  // The edit takes the stamp from the row it rewrites: Claude has no form open to carry one.
  server.registerTool(
    "update_movement",
    {
      description: t("tools.updateMovement"),
      inputSchema: z.object({ transactionId: z.string(), ...movementShape }),
      annotations: { ...write, idempotentHint: true },
    },
    (input: MovementInput & { transactionId: string }, ctx) =>
      run(ctx, async () => {
        const current = await getTransactionById(input.transactionId);
        if (!current) throw new ActionError("errors.notFound");
        await reviseMovement(
          parseForm(updateTransactionSchema, {
            ...movementForm(input),
            transactionId: input.transactionId,
            labelIds: current.labels.map((label) => label.id),
            causedByTransactionId: current.causedByTransactionId,
            expectedUpdatedAt: current.updatedAt,
          }),
        );
        return { transactionId: input.transactionId };
      }),
  );

  server.registerTool(
    "delete_movement",
    {
      description: t("tools.deleteMovement"),
      inputSchema: z.object({ transactionId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    (input: { transactionId: string }, ctx) =>
      run(ctx, async () => {
        await dropMovement(parseForm(z.uuid({ error: "errors.notFound" }), input.transactionId));
        return { transactionId: input.transactionId };
      }),
  );

  server.registerTool(
    "create_account",
    {
      description: t("tools.createAccount"),
      inputSchema: z.object({
        name: z.string(),
        kind: z.string(),
        subtype: z.string(),
        placement: z.string().default("personal"),
        settlementCurrency: z.string().default("COP"),
        openingBalanceCents: cents,
        balanceOn: date,
        institution: z.string().nullable().default(null),
        lastFour: z.string().optional(),
      }),
      annotations: write,
    },
    (input: Record<string, string | number | null | undefined>, ctx) =>
      run(ctx, async (owner) => {
        const { openingBalanceCents, ...rest } = input as { openingBalanceCents: number };
        return openAccount(parseForm(createAccountSchema, { ...rest, amount: centsToDecimal(openingBalanceCents) }), owner);
      }),
  );

  server.registerTool(
    "create_category",
    {
      description: t("tools.createCategory"),
      inputSchema: z.object({
        name: z.string(),
        kind: z.string(),
        parentId: z.string().nullable().default(null),
        placement: z.string().default("personal"),
        color: z.string().optional().describe(`Uno de ${CATEGORY_COLORS.join(", ")}; si falta, el primero libre.`),
      }),
      annotations: write,
    },
    (input: { color?: string }, ctx) =>
      run(ctx, async (owner) => {
        const color =
          input.color ?? nextCategoryColor((await listScopedCategories(owner)).flatMap((node) => (node.color ? [node.color] : [])));
        return openCategory(parseForm(createCategoryInputSchema, { ...input, color }), owner);
      }),
  );
}
