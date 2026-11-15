import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { getReconcileSheet, listAccountReconciliations } from "@/db/queries/account-reconciliations";
import { retireAccount } from "@/db/queries/account-write";
import { restoreAccount } from "@/db/queries/accounts";
import { confirmReconciliation } from "@/db/queries/reconcile-write";
import { ActionError } from "@/lib/errors";
import { OVERWRITE, READ, titled } from "@/lib/mcp/annotations";
import { parseForm } from "@/lib/mcp/parse-form";
import { centsToDecimal } from "@/lib/money";
import { reconcileAccountSchema } from "@/lib/validation/account-reconciliation";
import { archiveAccountSchema, restoreAccountSchema } from "@/lib/validation/account";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

// RF-233: archiving, restoring and counting an account, through the Cuentas screen's own queries, schemas and write
// functions. The account is an id `list_accounts` answers, from its archived side too.
export function registerAccountTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);
  const day = z.iso.date({ error: "transactions.errors.dateInvalid" });

  server.registerTool(
    "archive_account",
    {
      ...titled(t, "archiveAccount"),
      description: t("tools.archiveAccount"),
      inputSchema: z.object({ accountId: z.string().describe(d("targetAccountId")) }),
      annotations: OVERWRITE,
    },
    (input: { accountId: string }, ctx) =>
      run(ctx, async () => {
        const { accountId } = parseForm(archiveAccountSchema, input);
        await retireAccount({ accountId });
        return { accountId };
      }),
  );

  server.registerTool(
    "restore_account",
    {
      ...titled(t, "restoreAccount"),
      description: t("tools.restoreAccount"),
      inputSchema: z.object({ accountId: z.string().describe(d("targetAccountId")) }),
      annotations: OVERWRITE,
    },
    (input: { accountId: string }, ctx) =>
      run(ctx, async () => {
        const { accountId } = parseForm(restoreAccountSchema, input);
        if (!(await restoreAccount({ accountId }))) throw new ActionError("errors.notFound");
        return { accountId };
      }),
  );

  server.registerTool(
    "get_reconcile_sheet",
    {
      ...titled(t, "getReconcileSheet"),
      description: t("tools.getReconcileSheet"),
      inputSchema: z.object({ accountId: z.string().describe(d("targetAccountId")), on: z.string().describe(d("reconcileOn")) }),
      annotations: READ,
    },
    (input: { accountId: string; on: string }, ctx) =>
      run(ctx, async () => {
        const sheet = await getReconcileSheet(
          parseForm(z.uuid({ error: "transactions.errors.accountInvalid" }), input.accountId),
          parseForm(day, input.on),
        );
        if (sheet === null) throw new ActionError("errors.notFound");
        return sheet;
      }),
  );

  // «Cuadrar»: the count the person made and the figure the sheet derived; one adjustment movement holds the gap.
  server.registerTool(
    "reconcile_account",
    {
      ...titled(t, "reconcileAccount"),
      description: t("tools.reconcileAccount"),
      inputSchema: z.object({
        accountId: z.string().describe(d("targetAccountId")),
        reconciledOn: z.string().describe(d("reconcileOn")),
        realAmountCents: z.number().int().describe(d("reconcileRealAmountCents")),
        expectedDerivedCents: z.number().int().describe(d("reconcileExpectedDerivedCents")),
      }),
      annotations: OVERWRITE,
    },
    (input, ctx) =>
      run(ctx, async () => {
        const result = await confirmReconciliation(
          parseForm(reconcileAccountSchema, {
            accountId: input.accountId,
            reconciledOn: input.reconciledOn,
            realAmount: centsToDecimal(input.realAmountCents),
            expectedDerivedCents: input.expectedDerivedCents,
          }),
        );
        if (!result.ok) throw new ActionError(result.messageKey, result.date ? { date: result.date } : undefined);
        return { id: result.id, gapCents: result.gapCents };
      }),
  );

  server.registerTool(
    "list_reconciliations",
    {
      ...titled(t, "listReconciliations"),
      description: t("tools.listReconciliations"),
      inputSchema: z.object({ accountId: z.string().describe(d("targetAccountId")) }),
      annotations: READ,
    },
    (input: { accountId: string }, ctx) =>
      run(ctx, () => listAccountReconciliations(parseForm(z.uuid({ error: "transactions.errors.accountInvalid" }), input.accountId))),
  );
}
