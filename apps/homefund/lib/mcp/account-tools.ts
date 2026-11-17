import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  getReconcileSheet,
  reconcileAccounts,
  type ReconcileSheet,
  type ReconciledRow,
} from "@/db/queries/account-reconciliations";
import { retireAccount } from "@/db/queries/account-write";
import { listAccounts, restoreAccount } from "@/db/queries/accounts";
import { manyRefusalKey } from "@/db/queries/reconcile-write";
import { ActionError } from "@/lib/errors";
import { OVERWRITE, READ, titled } from "@/lib/mcp/annotations";
import { parseForm } from "@/lib/mcp/parse-form";
import { todayInBogota } from "@/lib/dates";
import { centsToDecimal } from "@/lib/money";
import { MAX_RECONCILED_TOGETHER, reconcileAccountsSchema } from "@/lib/validation/account-reconciliation";
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

// A refusal that names the account it came from: a count of many is all or nothing, so the person needs to know which.
export class AccountRefusal extends ActionError {
  constructor(
    messageKey: string,
    values: Record<string, string> | undefined,
    public accountId: string,
    public account: string | null,
  ) {
    super(messageKey, values);
  }
}

// One account of a count, as Claude reads it: a debt positive, the figure the account holds once counted beside the gap.
function countedRow(row: ReconciledRow) {
  return {
    accountId: row.accountId,
    name: row.name,
    kind: row.kind,
    currency: row.currency,
    derivedCents: owed(row.kind, row.derivedCents),
    realAmountCents: owed(row.kind, row.countedCents),
    gapCents: owed(row.kind, row.gapCents),
    resultingBalanceCents: owed(row.kind, row.countedCents),
    signFlip: row.signFlip,
    reconciliationId: row.reconciliationId,
  };
}

type CountItem = { accountId: string; realAmountCents: number; expectedDerivedCents?: number; confirmSignChange?: boolean };

// The one door every count of the MCP goes through: the schema of the form reads the lot, the write function counts it.
async function count(reconciledOn: string, items: CountItem[], dryRun: boolean) {
  const form = parseForm(reconcileAccountsSchema, {
    reconciledOn,
    items: items.map((item) => ({
      accountId: item.accountId,
      realAmount: centsToDecimal(item.realAmountCents),
      expectedDerivedCents: item.expectedDerivedCents ?? 0,
    })),
  });
  if (!dryRun && items.some((item) => item.expectedDerivedCents === undefined)) {
    throw new ActionError("mcp.errors.reconcileNeedsExpected");
  }

  const result = await reconcileAccounts({
    reconciledOn: form.reconciledOn,
    dryRun,
    expectedFrame: "owed",
    items: form.items.map((item, index) => ({
      accountId: item.accountId,
      realAmount: item.realAmount,
      expectedDerivedCents: items[index].expectedDerivedCents ?? null,
      guardSign: !items[index].confirmSignChange,
    })),
  });
  if (result.ok) return result.rows;

  const { messageKey, date } = manyRefusalKey(result);
  const values: Record<string, string> = {};
  if (date) values.date = date;
  if (result.reason === "signFlip" && result.kind && result.counted !== undefined && result.derived !== undefined) {
    values.real = String(owed(result.kind, result.counted));
    values.derived = String(owed(result.kind, result.derived));
  }
  throw new AccountRefusal(messageKey, values, result.accountId, result.name);
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
        expectedDerivedCents: z.number().int().optional().describe(d("reconcileExpectedDerivedCents")),
        confirmSignChange: z.boolean().optional().describe(d("reconcileConfirmSignChange")),
        dryRun: z.boolean().optional().describe(d("reconcileDryRun")),
      }),
      annotations: OVERWRITE,
    },
    (input, ctx) =>
      run(ctx, async () => {
        const dryRun = input.dryRun === true;
        const [row] = await count(input.reconciledOn, [input], dryRun);
        const read = countedRow(row);
        return dryRun ? { dryRun: true, ...read } : { id: row.reconciliationId, ...read };
      }),
  );

  // RF-252: many accounts counted on one day, all or nothing; the dry run is what the person says yes to.
  server.registerTool(
    "reconcile_accounts",
    {
      ...titled(t, "reconcileAccounts"),
      description: t("tools.reconcileAccounts"),
      inputSchema: z.object({
        reconciledOn: z.string().optional().describe(d("reconcileAccountsOn")),
        accounts: z
          .array(
            z.object({
              accountId: z.string().describe(d("targetAccountId")),
              realAmountCents: z.number().int().describe(d("reconcileRealAmountCents")),
              expectedDerivedCents: z.number().int().optional().describe(d("reconcileExpectedDerivedCents")),
              confirmSignChange: z.boolean().optional().describe(d("reconcileConfirmSignChange")),
            }),
          )
          .min(1)
          .max(MAX_RECONCILED_TOGETHER),
        dryRun: z.boolean().optional().describe(d("reconcileDryRun")),
      }),
      annotations: OVERWRITE,
    },
    (input, ctx) =>
      run(ctx, async () => {
        const dryRun = input.dryRun === true;
        const rows = (await count(input.reconciledOn ?? todayInBogota(), input.accounts, dryRun)).map(countedRow);
        return { dryRun, written: !dryRun, reconciledOn: input.reconciledOn ?? todayInBogota(), rows };
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
      run(ctx, async () => {
        const sheet = await getReconcileSheet(
          parseForm(z.uuid({ error: "transactions.errors.accountInvalid" }), input.accountId),
          todayInBogota(),
        );
        if (sheet === null) throw new ActionError("errors.notFound");
        return sheetAsOwed(sheet).history;
      }),
  );
}
