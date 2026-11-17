import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  openRecurringRule,
  pauseRecurringRule,
  resumeRecurringRule,
  reviseRecurringRule,
} from "@/db/queries/recurring-rule-write";
import { listRecurringRules, markTransactionReviewed } from "@/db/queries/recurring-rules";
import { ActionError } from "@/lib/errors";
import { OVERWRITE, READ, ADD, previousFields, titled } from "@/lib/mcp/annotations";
import { parseForm } from "@/lib/mcp/parse-form";
import { centsToDecimal } from "@/lib/money";
import {
  createRecurringRuleSchema,
  markMovementReviewedSchema,
  pauseRecurringRuleSchema,
  resumeRecurringRuleSchema,
  updateRecurringRuleSchema,
} from "@/lib/validation/recurring-rule";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

const FREQUENCIES = ["monthly", "weekly", "yearly"] as const;

// RF-231: «Lo que viene»'s rules, with their list and writes, through its own query, schemas and write functions, and the «Revisado»
// stamp a generated movement takes. A rule is one-sided, an income into one account or an expense out of one.
export function registerRecurringTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);

  server.registerTool(
    "list_recurring_rules",
    { ...titled(t, "listRecurringRules"), description: t("tools.listRecurringRules"), inputSchema: z.object({}), annotations: READ },
    (_input, ctx) => run(ctx, () => listRecurringRules()),
  );

  server.registerTool(
    "create_recurring_rule",
    {
      ...titled(t, "createRecurringRule"),
      description: t("tools.createRecurringRule"),
      inputSchema: z.object({
        fromAccountId: z.string().nullable().describe(d("fromAccountId")),
        toAccountId: z.string().nullable().describe(d("toAccountId")),
        amountCents: z.number().int().describe(d("amountCents")),
        categoryId: z.string().describe(d("recurringCategoryId")),
        description: z.string().nullish().describe(d("description")),
        frequency: z.enum(FREQUENCIES).describe(d("recurringFrequency")),
        intervalN: z.number().int().optional().describe(d("recurringIntervalN")),
        dayOfMonth: z.number().int().nullish().describe(d("recurringDayOfMonth")),
        nextRunOn: z.string().describe(d("recurringNextRunOn")),
        endsOn: z.string().nullish().describe(d("recurringEndsOn")),
      }),
      annotations: ADD,
    },
    (input, ctx) =>
      run(ctx, () => {
        const { amountCents, ...rest } = input;
        return openRecurringRule(parseForm(createRecurringRuleSchema, { ...rest, amount: centsToDecimal(amountCents) }));
      }),
  );

  // The stamp is the one list_recurring_rules answered: an edit over someone else's save is refused as out of date (RF-156).
  server.registerTool(
    "update_recurring_rule",
    {
      ...titled(t, "updateRecurringRule"),
      description: t("tools.updateRecurringRule"),
      inputSchema: z.object({
        id: z.string().describe(d("recurringRuleId")),
        expectedUpdatedAt: z.string().describe(d("expectedUpdatedAt")),
        fromAccountId: z.string().nullish().describe(d("fromAccountId")),
        toAccountId: z.string().nullish().describe(d("toAccountId")),
        amountCents: z.number().int().optional().describe(d("amountCents")),
        categoryId: z.string().optional().describe(d("recurringCategoryId")),
        description: z.string().nullish().describe(d("description")),
        frequency: z.enum(FREQUENCIES).optional().describe(d("recurringFrequency")),
        intervalN: z.number().int().optional().describe(d("recurringIntervalN")),
        dayOfMonth: z.number().int().nullish().describe(d("recurringDayOfMonth")),
        nextRunOn: z.string().optional().describe(d("recurringNextRunOn")),
        endsOn: z.string().nullish().describe(d("recurringEndsOn")),
      }),
      annotations: OVERWRITE,
    },
    (input, ctx) =>
      run(ctx, async () => {
        const id = parseForm(z.uuid({ error: "errors.notFound" }), input.id);
        const current = (await listRecurringRules()).find((row) => row.id === id);
        if (!current || current.foreignOwner) throw new ActionError("errors.notFound");
        const pick = <T>(sent: T | undefined, stored: T): T => (sent === undefined ? stored : sent);
        await reviseRecurringRule(
          parseForm(updateRecurringRuleSchema, {
            id,
            fromAccountId: pick(input.fromAccountId, current.fromAccountId),
            toAccountId: pick(input.toAccountId, current.toAccountId),
            amount: centsToDecimal(pick(input.amountCents, current.amountCents)),
            categoryId: pick(input.categoryId, current.categoryId),
            description: pick(input.description, current.description),
            frequency: pick(input.frequency, current.frequency),
            intervalN: pick(input.intervalN, current.intervalN),
            dayOfMonth: pick(input.dayOfMonth, current.dayOfMonth),
            nextRunOn: pick(input.nextRunOn, current.nextRunOn),
            endsOn: pick(input.endsOn, current.endsOn),
            expectedUpdatedAt: input.expectedUpdatedAt,
          }),
        );
        return {
          id,
          before: previousFields(
            {
              fromAccountId: current.fromAccountId,
              toAccountId: current.toAccountId,
              amountCents: current.amountCents,
              categoryId: current.categoryId,
              description: current.description,
              frequency: current.frequency,
              intervalN: current.intervalN,
              dayOfMonth: current.dayOfMonth,
              nextRunOn: current.nextRunOn,
              endsOn: current.endsOn,
            },
            input,
          ),
        };
      }),
  );

  server.registerTool(
    "pause_recurring_rule",
    {
      ...titled(t, "pauseRecurringRule"),
      description: t("tools.pauseRecurringRule"),
      inputSchema: z.object({ id: z.string().describe(d("recurringRuleId")) }),
      annotations: OVERWRITE,
    },
    (input: { id: string }, ctx) =>
      run(ctx, async () => {
        const { id } = parseForm(pauseRecurringRuleSchema, input);
        await pauseRecurringRule(id);
        return { id };
      }),
  );

  server.registerTool(
    "resume_recurring_rule",
    {
      ...titled(t, "resumeRecurringRule"),
      description: t("tools.resumeRecurringRule"),
      inputSchema: z.object({ id: z.string().describe(d("recurringRuleId")) }),
      annotations: OVERWRITE,
    },
    (input: { id: string }, ctx) =>
      run(ctx, async () => {
        const { id } = parseForm(resumeRecurringRuleSchema, input);
        await resumeRecurringRule(id);
        return { id };
      }),
  );

  // «Revisado»: only a generated, still unreviewed movement takes the stamp; a manual one reads as not found.
  server.registerTool(
    "mark_movement_reviewed",
    {
      ...titled(t, "markMovementReviewed"),
      description: t("tools.markMovementReviewed"),
      inputSchema: z.object({ transactionId: z.string().describe(d("transactionId")) }),
      annotations: OVERWRITE,
    },
    (input: { transactionId: string }, ctx) =>
      run(ctx, async () => {
        const { transactionId } = parseForm(markMovementReviewedSchema, input);
        if (!(await markTransactionReviewed({ transactionId }))) throw new ActionError("errors.notFound");
        return { transactionId };
      }),
  );
}
