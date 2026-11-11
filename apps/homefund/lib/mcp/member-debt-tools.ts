import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { getMemberDebts, recordMemberDebt } from "@/db/queries/member-debts";
import { ActionError } from "@/lib/errors";
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
    { description: t("tools.listMemberDebts"), inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    (_input, ctx) =>
      run(ctx, async () => {
        const data = await getMemberDebts();
        if (data === null) throw new ActionError("memberDebts.errors.noFund");
        return { balances: data.balances, entries: data.entries };
      }),
  );

  server.registerTool(
    "record_member_debt",
    {
      description: t("tools.recordMemberDebt"),
      inputSchema: z.object({
        kind: z.enum(MEMBER_DEBT_KINDS).describe(d("memberDebtKind")),
        debtorMemberId: z.string().describe(d("debtorMemberId")),
        creditorMemberId: z.string().describe(d("creditorMemberId")),
        amountCents: z.number().int().describe(d("amountCents")),
        currency: z.string().optional().describe(d("currency")),
        occurredOn: z.string().describe(d("occurredOn")),
        description: z.string().nullable().default(null).describe(d("description")),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (input, ctx) =>
      run(ctx, () =>
        recordMemberDebt(parseForm(recordMemberDebtSchema, { ...input, amount: centsToDecimal(input.amountCents) })),
      ),
  );
}
