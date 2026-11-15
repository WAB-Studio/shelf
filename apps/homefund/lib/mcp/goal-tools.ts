import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { contributeToGoal, openGoal, reviseGoal } from "@/db/queries/goal-write";
import {
  archiveGoal,
  listGoalContributions,
  listGoalsWithProgress,
  removeGoalContribution,
  restoreGoal,
} from "@/db/queries/savings-goals";
import { ActionError } from "@/lib/errors";
import { ADD, DESTROY, OVERWRITE, READ, previousFields, titled } from "@/lib/mcp/annotations";
import { parseForm } from "@/lib/mcp/parse-form";
import { centsToDecimal } from "@/lib/money";
import {
  archiveGoalSchema,
  contributeGoalSchema,
  createGoalSchema,
  goalContributionsSchema,
  removeGoalContributionSchema,
  restoreGoalSchema,
  updateGoalSchema,
} from "@/lib/validation/savings-goal";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

// RF-229: the Metas screen's list and writes, through its own query, schemas and write functions. A goal is the id
// `list_goals` answers; what is saved is the sum of its contributions, derived on every read and never stored.
export function registerGoalTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);
  const goalIdOf = (value: string) => parseForm(z.uuid({ error: "errors.notFound" }), value);

  server.registerTool(
    "list_goals",
    {
      ...titled(t, "listGoals"),
      description: t("tools.listGoals"),
      inputSchema: z.object({ archived: z.boolean().optional().describe(d("goalArchived")) }),
      annotations: READ,
    },
    (input: { archived?: boolean }, ctx) => run(ctx, () => listGoalsWithProgress({ archived: input.archived ?? false })),
  );

  server.registerTool(
    "create_goal",
    {
      ...titled(t, "createGoal"),
      description: t("tools.createGoal"),
      inputSchema: z.object({
        name: z.string().describe(d("goalName")),
        targetAmountCents: z.number().int().describe(d("goalTargetAmountCents")),
        targetDate: z.string().nullish().describe(d("goalTargetDate")),
        accountId: z.string().nullish().describe(d("goalAccountId")),
        initialContributionCents: z.number().int().nullish().describe(d("goalInitialContributionCents")),
      }),
      annotations: ADD,
    },
    (input, ctx) =>
      run(ctx, async (owner) =>
        openGoal(
          parseForm(createGoalSchema, {
            name: input.name,
            targetAmount: centsToDecimal(input.targetAmountCents),
            targetDate: input.targetDate,
            accountId: input.accountId,
            initialContribution: input.initialContributionCents == null ? null : centsToDecimal(input.initialContributionCents),
          }),
          owner,
        ),
      ),
  );

  // The stamp is the one list_goals answered: an edit over someone else's save is refused as out of date (RF-156).
  server.registerTool(
    "update_goal",
    {
      ...titled(t, "updateGoal"),
      description: t("tools.updateGoal"),
      inputSchema: z.object({
        goalId: z.string().describe(d("goalId")),
        expectedUpdatedAt: z.string().describe(d("expectedUpdatedAt")),
        name: z.string().optional().describe(d("goalName")),
        targetAmountCents: z.number().int().optional().describe(d("goalTargetAmountCents")),
        targetDate: z.string().nullish().describe(d("goalTargetDate")),
        accountId: z.string().nullish().describe(d("goalAccountId")),
      }),
      annotations: OVERWRITE,
    },
    (input, ctx) =>
      run(ctx, async () => {
        const goalId = goalIdOf(input.goalId);
        const current = (await listGoalsWithProgress()).find((row) => row.id === goalId);
        if (!current || current.foreignOwner) throw new ActionError("errors.notFound");
        const pick = <T>(sent: T | undefined, stored: T): T => (sent === undefined ? stored : sent);
        await reviseGoal(
          parseForm(updateGoalSchema, {
            goalId,
            name: pick(input.name, current.name),
            targetAmount: centsToDecimal(pick(input.targetAmountCents, current.targetAmountCents)),
            targetDate: pick(input.targetDate, current.targetDate),
            accountId: pick(input.accountId, current.accountId),
            expectedUpdatedAt: input.expectedUpdatedAt,
          }),
        );
        return {
          goalId,
          before: previousFields(
            { name: current.name, targetAmountCents: current.targetAmountCents, targetDate: current.targetDate, accountId: current.accountId },
            input,
          ),
        };
      }),
  );

  server.registerTool(
    "archive_goal",
    {
      ...titled(t, "archiveGoal"),
      description: t("tools.archiveGoal"),
      inputSchema: z.object({ goalId: z.string().describe(d("goalId")) }),
      annotations: OVERWRITE,
    },
    (input: { goalId: string }, ctx) =>
      run(ctx, async () => {
        const { goalId } = parseForm(archiveGoalSchema, input);
        if (!(await archiveGoal({ goalId }))) throw new ActionError("errors.notFound");
        return { goalId };
      }),
  );

  server.registerTool(
    "restore_goal",
    {
      ...titled(t, "restoreGoal"),
      description: t("tools.restoreGoal"),
      inputSchema: z.object({ goalId: z.string().describe(d("goalId")) }),
      annotations: OVERWRITE,
    },
    (input: { goalId: string }, ctx) =>
      run(ctx, async () => {
        const { goalId } = parseForm(restoreGoalSchema, input);
        if (!(await restoreGoal({ goalId }))) throw new ActionError("errors.notFound");
        return { goalId };
      }),
  );

  server.registerTool(
    "contribute_goal",
    {
      ...titled(t, "contributeGoal"),
      description: t("tools.contributeGoal"),
      inputSchema: z.object({
        goalId: z.string().describe(d("goalId")),
        amountCents: z.number().int().describe(d("goalContributionCents")),
      }),
      annotations: ADD,
    },
    (input, ctx) =>
      run(ctx, () => contributeToGoal(parseForm(contributeGoalSchema, { goalId: input.goalId, amount: centsToDecimal(input.amountCents) }))),
  );

  server.registerTool(
    "list_goal_contributions",
    {
      ...titled(t, "listGoalContributions"),
      description: t("tools.listGoalContributions"),
      inputSchema: z.object({ goalId: z.string().describe(d("goalId")) }),
      annotations: READ,
    },
    (input: { goalId: string }, ctx) => run(ctx, () => listGoalContributions(parseForm(goalContributionsSchema, input).goalId)),
  );

  // The goal is named too: the contribution is read from its list first, so the answer can put it back with contribute_goal.
  server.registerTool(
    "remove_goal_contribution",
    {
      ...titled(t, "removeGoalContribution"),
      description: t("tools.removeGoalContribution"),
      inputSchema: z.object({
        goalId: z.string().describe(d("goalId")),
        contributionId: z.string().describe(d("goalContributionId")),
      }),
      annotations: DESTROY,
    },
    (input: { goalId: string; contributionId: string }, ctx) =>
      run(ctx, async () => {
        const { goalId } = parseForm(goalContributionsSchema, { goalId: input.goalId });
        const { contributionId } = parseForm(removeGoalContributionSchema, { contributionId: input.contributionId });
        const before = (await listGoalContributions(goalId)).find((row) => row.id === contributionId);
        if (!before || !(await removeGoalContribution({ contributionId }))) throw new ActionError("errors.notFound");
        return { contributionId, before: { goalId, ...before } };
      }),
  );
}
