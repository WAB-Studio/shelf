import "server-only";

import { reconcileAccount } from "@/db/queries/account-reconciliations";
import { getSettlementCurrencies } from "@/db/queries/transactions";
import { BASE_CURRENCY } from "@/lib/currency";
import { ActionError } from "@/lib/errors";
import {
  checkRealAmount,
  type ReconcileAccountInput,
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
