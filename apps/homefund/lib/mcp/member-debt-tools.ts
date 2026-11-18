import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { getMemberDebts, recordMemberDebt } from "@/db/queries/member-debts";
import { todayInBogota } from "@/lib/dates";
import { ActionError } from "@/lib/errors";
import { ADD, READ, titled } from "@/lib/mcp/annotations";
import { memberDebtStates } from "@/lib/member-debts";
import { parseForm } from "@/lib/mcp/parse-form";
import { centsToDecimal } from "@/lib/money";
import { MEMBER_DEBT_KINDS, recordMemberDebtSchema } from "@/lib/validation/member-debt";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

// RF-183: what members of the fund owe each other, read and written through the same query and schema as
// Planeación → Deudas. The members are the ids `list_members` answers.
export function registerMemberDebtTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);

  server.registerTool(
    "list_member_debts",
    { ...titled(t, "listMemberDebts"), description: t("tools.listMemberDebts"), inputSchema: z.object({}), annotations: READ },
    (_input, ctx) =>
      run(ctx, async () => {
        const data = await getMemberDebts();
        if (data === null) throw new ActionError("memberDebts.errors.noFund");
        // Each debt carries its derived state: pending, partial or settled, and the day it was settled.
        const states = memberDebtStates(data.entries);
        return {
          balances: data.balances,
          entries: data.entries.map((entry) => ({ ...entry, ...(states.get(entry.id) ?? {}) })),
        };
      }),
  );

  server.registerTool(
    "record_member_debt",
    {
      ...titled(t, "recordMemberDebt"),
      description: t("tools.recordMemberDebt"),
      inputSchema: z.object({
        kind: z.enum(MEMBER_DEBT_KINDS).describe(d("memberDebtKind")),
        debtorMemberId: z.string().describe(d("debtorMemberId")),
        creditorMemberId: z.string().describe(d("creditorMemberId")),
        amountCents: z.number().int().describe(d("amountCents")),
        currency: z.string().optional().describe(d("currency")),
        occurredOn: z.string().optional().describe(d("occurredOnDefault")),
        description: z.string().nullable().default(null).describe(d("description")),
      }),
      annotations: ADD,
    },
    (input, ctx) =>
      run(ctx, () =>
        recordMemberDebt(
          parseForm(recordMemberDebtSchema, { ...input, occurredOn: input.occurredOn ?? todayInBogota(), amount: centsToDecimal(input.amountCents) }),
        ),
      ),
  );
}
