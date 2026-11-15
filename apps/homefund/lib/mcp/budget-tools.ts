import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { archiveBudget, listBudgetsWithStatus, restoreBudget } from "@/db/queries/budgets";
import { openBudget, reviseBudget } from "@/db/queries/budget-write";
import { ActionError } from "@/lib/errors";
import { ADD, OVERWRITE, READ, previousFields, titled } from "@/lib/mcp/annotations";
import { resolveLabelIds } from "@/lib/mcp/label-tools";
import { parseForm } from "@/lib/mcp/parse-form";
import { centsToDecimal } from "@/lib/money";
import {
  BUDGET_PERIODS,
  archiveBudgetSchema,
  createBudgetSchema,
  restoreBudgetSchema,
  updateBudgetSchema,
} from "@/lib/validation/budget";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

// RF-228: the Presupuestos screen's list and writes, through its own query, schemas and write functions. A budget is
// the id `list_budgets` answers; the spent and remaining figures are derived on every read and never stored.
export function registerBudgetTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);
  // A label by id or by name, as the movement tools take it; null clears it.
  const labelOf = async (owner: string, ref: string | null | undefined) =>
    ref == null ? null : (await resolveLabelIds(owner, [ref]))[0];

  server.registerTool(
    "list_budgets",
    {
      ...titled(t, "listBudgets"),
      description: t("tools.listBudgets"),
      inputSchema: z.object({
        archived: z.boolean().optional().describe(d("budgetArchived")),
        anchorDate: z.iso.date().optional().describe(d("budgetAnchorDate")),
      }),
      annotations: READ,
    },
    (input: { archived?: boolean; anchorDate?: string }, ctx) =>
      run(ctx, () => listBudgetsWithStatus(input.anchorDate, { archived: input.archived ?? false })),
  );

  server.registerTool(
    "create_budget",
    {
      ...titled(t, "createBudget"),
      description: t("tools.createBudget"),
      inputSchema: z.object({
        categoryId: z.string().describe(d("budgetCategoryId")),
        period: z.enum(BUDGET_PERIODS).describe(d("budgetPeriod")),
        limitCents: z.number().int().describe(d("budgetLimitCents")),
        thresholdPct: z.number().int().describe(d("budgetThresholdPct")),
        accountId: z.string().nullish().describe(d("budgetAccountId")),
        labelId: z.string().nullish().describe(d("budgetLabel")),
        name: z.string().nullish().describe(d("budgetName")),
      }),
      annotations: ADD,
    },
    (input, ctx) =>
      run(ctx, async (owner) =>
        openBudget(
          parseForm(createBudgetSchema, {
            categoryId: input.categoryId,
            accountId: input.accountId,
            labelId: await labelOf(owner, input.labelId),
            period: input.period,
            limit: centsToDecimal(input.limitCents),
            thresholdPct: input.thresholdPct,
            name: input.name,
          }),
        ),
      ),
  );

  // The stamp is the one list_budgets answered: an edit after someone else's save is refused as out of date (RF-156).
  server.registerTool(
    "update_budget",
    {
      ...titled(t, "updateBudget"),
      description: t("tools.updateBudget"),
      inputSchema: z.object({
        budgetId: z.string().describe(d("budgetId")),
        expectedUpdatedAt: z.string().describe(d("expectedUpdatedAt")),
        period: z.enum(BUDGET_PERIODS).optional().describe(d("budgetPeriod")),
        limitCents: z.number().int().optional().describe(d("budgetLimitCents")),
        thresholdPct: z.number().int().optional().describe(d("budgetThresholdPct")),
        accountId: z.string().nullish().describe(d("budgetAccountId")),
        labelId: z.string().nullish().describe(d("budgetLabel")),
        name: z.string().nullish().describe(d("budgetName")),
      }),
      annotations: OVERWRITE,
    },
    (input, ctx) =>
      run(ctx, async (owner) => {
        const budgetId = parseForm(z.uuid({ error: "errors.notFound" }), input.budgetId);
        const current = (await listBudgetsWithStatus()).find((row) => row.id === budgetId);
        if (!current || current.foreignOwner) throw new ActionError("errors.notFound");
        const pick = <T>(sent: T | undefined, stored: T): T => (sent === undefined ? stored : sent);
        await reviseBudget(
          parseForm(updateBudgetSchema, {
            budgetId,
            accountId: pick(input.accountId, current.accountId),
            labelId: input.labelId === undefined ? current.labelId : await labelOf(owner, input.labelId),
            period: pick(input.period, current.period),
            limit: centsToDecimal(pick(input.limitCents, current.limitCents)),
            thresholdPct: pick(input.thresholdPct, current.thresholdPct),
            name: pick(input.name, current.name),
            expectedUpdatedAt: input.expectedUpdatedAt,
          }),
        );
        return {
          budgetId,
          before: previousFields(
            {
              period: current.period,
              limitCents: current.limitCents,
              thresholdPct: current.thresholdPct,
              accountId: current.accountId,
              labelId: current.labelId,
              name: current.name,
            },
            input,
          ),
        };
      }),
  );

  server.registerTool(
    "archive_budget",
    {
      ...titled(t, "archiveBudget"),
      description: t("tools.archiveBudget"),
      inputSchema: z.object({ budgetId: z.string().describe(d("budgetId")) }),
      annotations: OVERWRITE,
    },
    (input: { budgetId: string }, ctx) =>
      run(ctx, async () => {
        const { budgetId } = parseForm(archiveBudgetSchema, input);
        if (!(await archiveBudget({ budgetId }))) throw new ActionError("errors.notFound");
        return { budgetId };
      }),
  );

  server.registerTool(
    "restore_budget",
    {
      ...titled(t, "restoreBudget"),
      description: t("tools.restoreBudget"),
      inputSchema: z.object({ budgetId: z.string().describe(d("budgetId")) }),
      annotations: OVERWRITE,
    },
    (input: { budgetId: string }, ctx) =>
      run(ctx, async () => {
        const { budgetId } = parseForm(restoreBudgetSchema, input);
        if (!(await restoreBudget({ budgetId }))) throw new ActionError("errors.notFound");
        return { budgetId };
      }),
  );
}
