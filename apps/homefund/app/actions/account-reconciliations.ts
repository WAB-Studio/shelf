"use server";

import { refresh, revalidatePath } from "next/cache";
import { z } from "zod";

import { getReconcileSheet } from "@/db/queries/account-reconciliations";
import type { ReconcileSheet } from "@/db/queries/account-reconciliations";
import { confirmReconciliation } from "@/db/queries/reconcile-write";
import type { ReconcileActionResult } from "@/db/queries/reconcile-write";
import { isCivilDate } from "@/lib/dates";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import { reconcileAccountSchema } from "@/lib/validation/account-reconciliation";

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

/**
 * Counts an account on a day (RF-137). The layout purge reaches the other screens' cached trees on
 * their next visit; only `refresh` re-renders the screen the dialog sits on, which the dialog stays open over.
 */
export const reconcileAccountAction = authActionClient
  .inputSchema(reconcileAccountSchema)
  .action(async ({ parsedInput }): Promise<ReconcileActionResult> => {
    const result = await confirmReconciliation(parsedInput);

    if (result.ok) {
      revalidatePath("/[locale]", "layout");
      refresh();
    }
    return result;
  });
