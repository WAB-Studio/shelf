import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { convertToLoan } from "@/db/queries/ledger-write";
import { ActionError } from "@/lib/errors";
import { DESTROY, titled } from "@/lib/mcp/annotations";
import { parseForm } from "@/lib/mcp/parse-form";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

const RECEIVABLE_NAME_MAX = 80;

// RF-252: an expense paid for somebody, and the incomes that repaid it, become transfers through that person's «Me debe».
export function registerLoanTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);

  server.registerTool(
    "convert_to_loan",
    {
      ...titled(t, "convertToLoan"),
      description: t("tools.convertToLoan"),
      inputSchema: z.object({
        outgoingTransactionId: z.string().describe(d("loanOutgoingId")),
        personName: z.string().trim().min(1).max(60).describe(d("loanPersonName")),
        repaymentTransactionIds: z.array(z.string()).max(50).optional().describe(d("loanRepaymentIds")),
        dryRun: z.boolean().optional().describe(d("loanDryRun")),
        expectedOwedCents: z.number().int().min(0).optional().describe(d("loanExpectedOwed")),
      }),
      annotations: DESTROY,
    },
    (input: { outgoingTransactionId: string; personName: string; repaymentTransactionIds?: string[]; dryRun?: boolean; expectedOwedCents?: number }, ctx) =>
      run(ctx, async () => {
        const uuid = (value: string) => parseForm(z.uuid({ error: "errors.notFound" }), value);
        const dryRun = input.dryRun ?? false;
        if (!dryRun && input.expectedOwedCents === undefined) throw new ActionError("mcp.errors.loan.needsOwed");
        return convertToLoan({
          outgoingId: uuid(input.outgoingTransactionId),
          repaymentIds: (input.repaymentTransactionIds ?? []).map(uuid),
          receivableName: `${t("loanAccountPrefix")}${input.personName}`.slice(0, RECEIVABLE_NAME_MAX),
          dryRun,
          expectedOwedCents: input.expectedOwedCents,
        });
      }),
  );
}
