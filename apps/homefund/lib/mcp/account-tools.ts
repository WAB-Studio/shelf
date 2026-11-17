import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { getReconcileSheet, listAccountReconciliations, type ReconcileSheet } from "@/db/queries/account-reconciliations";
import { retireAccount } from "@/db/queries/account-write";
import { listAccounts, restoreAccount } from "@/db/queries/accounts";
import { confirmReconciliation } from "@/db/queries/reconcile-write";
import { ActionError } from "@/lib/errors";
import { OVERWRITE, READ, titled } from "@/lib/mcp/annotations";
import { parseForm } from "@/lib/mcp/parse-form";
import { centsToDecimal } from "@/lib/money";
import { reconcileAccountSchema } from "@/lib/validation/account-reconciliation";
import { archiveAccountSchema, restoreAccountSchema } from "@/lib/validation/account";

// An account as list_accounts answers it, and as a tool that removes one answers what it removed.
export function accountRow(account: Awaited<ReturnType<typeof listAccounts>>[number]) {
  return {
    id: account.id,
    name: account.name,
    kind: account.kind,
    subtype: account.subtype,
    scope: account.groupId === null ? "personal" : "fund",
    institution: account.institution,
    lastFour: account.lastFour ?? null,
    // The account this one is a pocket of, null for an account of its own (RF-173); a parent's balances are its free part.
    parentAccountId: account.parentAccountId ?? null,
    // The fund member this account is in the name of (RF-181), null for an account of everyone.
    holderMemberId: account.holderMemberId ?? null,
    holderName: account.holderName ?? null,
    settlementCurrency: account.settlementCurrency,
    // What update_account takes back: the opening as the form shows it (a liability's debt positive), its date and the stamp.
    openingBalanceCents: account.kind === "liability" ? -account.initialBalanceCents : account.initialBalanceCents,
    balanceOn: account.initialBalanceOn,
    updatedAt: account.updatedAt,
    balances: account.balances,
    canWrite: account.canWrite,
  };
}

// RF-245: Claude reads and sends a debt as what is owed, positive, in every figure of the count; the ledger keeps it
// negative. The one place the two meet is here, so the sheet, the history and the count never disagree on a sign.
const owed = (kind: "asset" | "liability", cents: number) => (kind === "liability" && cents !== 0 ? -cents : cents);

function sheetAsOwed(sheet: ReconcileSheet) {
  const { kind } = sheet.account;
  return {
    account: { ...sheet.account, derivedCents: owed(kind, sheet.account.derivedCents) },
    history: sheet.history.map((row) => ({
      ...row,
      countedCents: owed(kind, row.countedCents),
      derivedCents: owed(kind, row.derivedCents),
      gapCents: owed(kind, row.gapCents),
    })),
  };
}

// A count whose sign is the opposite of the balance and whose gap is bigger than the balance itself is the shape of a
// sign slip (a debt typed negative), which books a gap twice the balance; it waits for the person's yes.
function flipsSign(real: number, derived: number): boolean {
  return real !== 0 && derived !== 0 && Math.sign(real) !== Math.sign(derived) && Math.abs(real - derived) > Math.abs(derived);
}

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
        return sheetAsOwed(sheet);
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
        confirmSignChange: z.boolean().optional().describe(d("reconcileConfirmSignChange")),
      }),
      annotations: OVERWRITE,
    },
    (input, ctx) =>
      run(ctx, async () => {
        const form = parseForm(reconcileAccountSchema, {
          accountId: input.accountId,
          reconciledOn: input.reconciledOn,
          realAmount: centsToDecimal(input.realAmountCents),
          expectedDerivedCents: input.expectedDerivedCents,
        });
        const sheet = await getReconcileSheet(form.accountId, form.reconciledOn);
        if (sheet === null) throw new ActionError("errors.notFound");
        const { kind } = sheet.account;
        const derived = owed(kind, sheet.account.derivedCents);
        if (!input.confirmSignChange && flipsSign(input.realAmountCents, derived)) {
          throw new ActionError("mcp.errors.reconcileSign", { real: String(input.realAmountCents), derived: String(derived) });
        }
        // The stamp is the ledger's own figure, so what Claude read as owed is turned back before the write compares them.
        const result = await confirmReconciliation({ ...form, expectedDerivedCents: owed(kind, input.expectedDerivedCents) });
        if (!result.ok) throw new ActionError(result.messageKey, result.date ? { date: result.date } : undefined);
        return { id: result.id, gapCents: owed(kind, result.gapCents) };
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
