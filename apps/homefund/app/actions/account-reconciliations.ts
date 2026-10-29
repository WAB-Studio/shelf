"use server";

import { refresh, revalidatePath } from "next/cache";
import { z } from "zod";

import {
  getReconcileSheet,
  reconcileAccount,
} from "@/db/queries/account-reconciliations";
import type { ReconcileSheet } from "@/db/queries/account-reconciliations";
import { getSettlementCurrencies } from "@/db/queries/transactions";
import { BASE_CURRENCY } from "@/lib/currency";
import { isCivilDate } from "@/lib/dates";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import {
  checkRealAmount,
  reconcileAccountSchema,
} from "@/lib/validation/account-reconciliation";

const readReconcileSheetSchema = z.object({
  accountId: z.uuid({ error: "transactions.errors.accountInvalid" }),
  on: z.string().refine(isCivilDate, { error: "transactions.errors.dateInvalid" }),
});

/** The sheet for one day; the dialog calls it on open and again whenever the day changes. */
export const readReconcileSheetAction = authActionClient
  .inputSchema(readReconcileSheetSchema)
  .action(async ({ parsedInput: { accountId, on } }): Promise<ReconcileSheet> => {
    const sheet = await getReconcileSheet(accountId, on);
    if (sheet === null) throw new ActionError("errors.notFound");
    return sheet;
  });

// A refusal that names a day is data, not a thrown key: `ActionError` carries a key and nothing
// to fill `{date}` with, and a stale one has to hand the dialog the figures to redraw.
export type ReconcileActionResult =
  | { ok: true; id: string; gapCents: number }
  | { ok: false; messageKey: string; date?: string };

/**
 * Counts an account on a day (RF-137). The typed figure is read against the currency the account
 * settles in, read off the account and never off the payload (RNF-10).
 */
export const reconcileAccountAction = authActionClient
  .inputSchema(reconcileAccountSchema)
  .action(
    async ({
      parsedInput: { accountId, reconciledOn, realAmount, expectedDerivedCents },
    }): Promise<ReconcileActionResult> => {
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

      // The layout purge reaches the other screens' cached trees on their next visit; only
      // `refresh` re-renders the screen the dialog sits on, which the dialog stays open over.
      revalidatePath("/[locale]", "layout");
      refresh();
      return { ok: true, id: result.id, gapCents: result.gapCents };
    },
  );
