import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { removeAccount } from "@/db/queries/account-write";
import { listAccounts } from "@/db/queries/accounts";
import { deleteBudget, listBudgetsWithStatus } from "@/db/queries/budgets";
import { dropCategory } from "@/db/queries/ledger-write";
import { deleteMemberDebt, getMemberDebts } from "@/db/queries/member-debts";
import { deletePlannedPayment, listPlannedPayments } from "@/db/queries/planned-payments";
import { deleteRecurringRule, listRecurringRules } from "@/db/queries/recurring-rules";
import { deleteGoal, listGoalsWithProgress } from "@/db/queries/savings-goals";
import { listThirdPartyCredits, removeThirdPartyCredit } from "@/db/queries/third-party-credits";
import { ActionError } from "@/lib/errors";
import { memberDebtStates } from "@/lib/member-debts";
import { accountRow } from "@/lib/mcp/account-tools";
import { DESTROY, titled } from "@/lib/mcp/annotations";
import { parseForm } from "@/lib/mcp/parse-form";
import { categoryRows } from "@/lib/mcp/write-tools";
import { deleteAccountSchema } from "@/lib/validation/account";
import { deleteBudgetSchema } from "@/lib/validation/budget";
import { deleteCategorySchema } from "@/lib/validation/category";
import { deleteMemberDebtSchema } from "@/lib/validation/member-debt";
import { deletePlannedPaymentSchema } from "@/lib/validation/planned-payment";
import { deleteRecurringRuleSchema } from "@/lib/validation/recurring-rule";
import { deleteGoalSchema } from "@/lib/validation/savings-goal";
import { removeThirdPartyCreditSchema } from "@/lib/validation/third-party-credit";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

// RF-238: what the web deletes, one row per call, by each screen's own delete and schema. Every answer carries the row
// as its list tool reads it, so the matching create tool can make it again. A label and a member are never deleted here.
export function registerDeleteTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);

  // One shape for the eight: read the row first, delete it, answer `{ <idKey>, before }`.
  function register(config: {
    tool: string;
    key: string;
    idKey: string;
    describe: string;
    schema: z.ZodType<Record<string, string>>;
    before: (owner: string, id: string) => Promise<unknown>;
    remove: (id: string) => Promise<void>;
  }): void {
    server.registerTool(
      config.tool,
      {
        ...titled(t, config.key),
        description: t(`tools.${config.key}`),
        inputSchema: z.object({ [config.idKey]: z.string().describe(d(config.describe)) }),
        annotations: DESTROY,
      },
      (input: Record<string, string>, ctx) =>
        run(ctx, async (owner) => {
          const id = parseForm(config.schema, input)[config.idKey];
          const before = await config.before(owner, id);
          if (before == null) throw new ActionError("errors.notFound");
          await config.remove(id);
          return { [config.idKey]: id, before };
        }),
    );
  }

  const both = async <T>(read: (archived: boolean) => Promise<T[]>) => (await Promise.all([read(false), read(true)])).flat();

  register({
    tool: "delete_account",
    key: "deleteAccount",
    idKey: "accountId",
    describe: "targetAccountId",
    schema: deleteAccountSchema,
    before: async (_owner, id) => (await both((archived) => listAccounts({ archived }))).map(accountRow).find((row) => row.id === id),
    remove: (id) => removeAccount({ accountId: id }),
  });

  register({
    tool: "delete_category",
    key: "deleteCategory",
    idKey: "categoryId",
    describe: "deleteCategoryId",
    schema: deleteCategorySchema,
    before: async (owner, id) => (await categoryRows(owner)).find((row) => row.id === id),
    remove: (id) => dropCategory({ categoryId: id }),
  });

  register({
    tool: "delete_budget",
    key: "deleteBudget",
    idKey: "budgetId",
    describe: "budgetId",
    schema: deleteBudgetSchema,
    before: async (_owner, id) => (await both((archived) => listBudgetsWithStatus(undefined, { archived }))).find((row) => row.id === id),
    remove: async (id) => {
      if (!(await deleteBudget({ budgetId: id }))) throw new ActionError("errors.notFound");
    },
  });

  register({
    tool: "delete_goal",
    key: "deleteGoal",
    idKey: "goalId",
    describe: "goalId",
    schema: deleteGoalSchema,
    before: async (_owner, id) => (await both((archived) => listGoalsWithProgress({ archived }))).find((row) => row.id === id),
    remove: async (id) => {
      if (!(await deleteGoal({ goalId: id }))) throw new ActionError("errors.notFound");
    },
  });

  register({
    tool: "delete_planned_payment",
    key: "deletePlannedPayment",
    idKey: "plannedPaymentId",
    describe: "plannedPaymentId",
    schema: deletePlannedPaymentSchema,
    before: async (_owner, id) => (await listPlannedPayments()).find((row) => row.id === id),
    remove: async (id) => {
      if (!(await deletePlannedPayment({ plannedPaymentId: id }))) throw new ActionError("errors.notFound");
    },
  });

  register({
    tool: "delete_recurring_rule",
    key: "deleteRecurringRule",
    idKey: "id",
    describe: "recurringRuleId",
    schema: deleteRecurringRuleSchema,
    before: async (_owner, id) => (await listRecurringRules()).find((row) => row.id === id),
    remove: async (id) => {
      if (!(await deleteRecurringRule({ id }))) throw new ActionError("errors.notFound");
    },
  });

  register({
    tool: "delete_member_debt",
    key: "deleteMemberDebt",
    idKey: "id",
    describe: "memberDebtId",
    schema: deleteMemberDebtSchema,
    before: async (_owner, id) => {
      const data = await getMemberDebts();
      const entry = data?.entries.find((row) => row.id === id);
      return entry && { ...entry, ...(memberDebtStates(data?.entries ?? []).get(id) ?? {}) };
    },
    remove: async (id) => {
      const result = await deleteMemberDebt(id);
      if (result === "notFound") throw new ActionError("errors.notFound");
      if (result === "paid") throw new ActionError("memberDebts.errors.debtPaid");
    },
  });

  register({
    tool: "unlink_third_party_credit",
    key: "unlinkThirdPartyCredit",
    idKey: "liabilityAccountId",
    describe: "creditLiabilityAccountId",
    schema: removeThirdPartyCreditSchema,
    before: async (_owner, id) => (await listThirdPartyCredits(id))[0],
    remove: (id) => removeThirdPartyCredit(id),
  });
}
