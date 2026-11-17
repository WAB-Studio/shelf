import "server-only";

import {
  reconcileAccount,
  reconcileAccounts,
  type ReconcileManyResult,
  type ReconciledRow,
} from "@/db/queries/account-reconciliations";
import { getSettlementCurrencies } from "@/db/queries/transactions";
import { BASE_CURRENCY } from "@/lib/currency";
import { ActionError } from "@/lib/errors";
import {
  checkRealAmount,
  type ReconcileAccountInput,
  type ReconcileAccountsInput,
} from "@/lib/validation/account-reconciliation";

// A refusal that names a day is data, not a thrown key: `ActionError` carries a key and nothing
// to fill `{date}` with, and a stale one has to hand the dialog the figures to redraw.
export type ReconcileActionResult =
  | { ok: true; id: string; gapCents: number }
  | { ok: false; messageKey: string; date?: string };

/**
 * Counts an account on a day (RF-137). The typed figure is read against the currency the account
 * settles in, read off the account and never off the payload (RNF-10).
 */
export async function confirmReconciliation({
  accountId,
  reconciledOn,
  realAmount,
  expectedDerivedCents,
}: ReconcileAccountInput): Promise<ReconcileActionResult> {
  const settlement = await getSettlementCurrencies({
    fromAccountId: accountId,
    toAccountId: null,
  });
  const real = checkRealAmount(realAmount, settlement.from ?? BASE_CURRENCY);
  if (!real.ok) throw new ActionError(real.messageKey);

  const result = await reconcileAccount({
    accountId,
    reconciledOn,
    realMagnitudeCents: real.cents,
    expectedDerivedCents,
  });

  if (!result.ok) {
    switch (result.reason) {
      case "stale":
        return { ok: false, messageKey: "errors.reconcileStale" };
      case "future":
        return { ok: false, messageKey: "errors.reconcileFutureDay" };
      case "beforeOpening":
        return { ok: false, messageKey: "errors.reconcileBeforeOpening", date: result.date };
      case "beforeLatest":
        return { ok: false, messageKey: "errors.reconcileBeforeLatest", date: result.date };
      case "denied":
        throw new ActionError("errors.notFound");
      case "archived":
        throw new ActionError("errors.reconcileFailed");
    }
  }

  return { ok: true, id: result.id, gapCents: result.gapCents };
}

// The sentence key a refused count answers in, and the day it names: one table for the screen and the MCP.
export function manyRefusalKey(
  refusal: Extract<ReconcileManyResult, { ok: false }>,
): { messageKey: string; date?: string } {
  switch (refusal.reason) {
    case "stale":
      return { messageKey: "errors.reconcileStale" };
    case "future":
      return { messageKey: "errors.reconcileFutureDay" };
    case "beforeOpening":
      return { messageKey: "errors.reconcileBeforeOpening", ...(refusal.date ? { date: refusal.date } : {}) };
    case "beforeLatest":
      return { messageKey: "errors.reconcileBeforeLatest", ...(refusal.date ? { date: refusal.date } : {}) };
    case "denied":
      return { messageKey: "errors.notFound" };
    case "amount":
      return { messageKey: refusal.messageKey ?? "errors.unexpected" };
    case "signFlip":
      return { messageKey: "mcp.errors.reconcileSign" };
    case "archived":
      return { messageKey: "errors.reconcileFailed" };
  }
}

export type ReconcileManyActionResult =
  | { ok: true; rows: ReconciledRow[] }
  | { ok: false; accountId: string; name: string | null; messageKey: string; date?: string };

/**
 * Counts many accounts on one day, all or nothing (RF-252). Each figure is read against the currency
 * its own account settles in, read off the account and never off the payload (RNF-10). The screen
 * shows a count that looks like a slip beside its row before it is sent, so nothing here refuses it.
 */
export async function confirmReconciliations({
  reconciledOn,
  items,
}: ReconcileAccountsInput): Promise<ReconcileManyActionResult> {
  const result = await reconcileAccounts({
    reconciledOn,
    dryRun: false,
    expectedFrame: "ledger",
    items: items.map((item) => ({ ...item, guardSign: false })),
  });
  if (result.ok) return result;

  return { ok: false, accountId: result.accountId, name: result.name, ...manyRefusalKey(result) };
}
