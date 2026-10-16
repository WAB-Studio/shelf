"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { deleteDebtTerms, upsertDebtTerms } from "@/db/queries/debt-terms";
import { getSettlementCurrencies } from "@/db/queries/transactions";
import { BASE_CURRENCY } from "@/lib/currency";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { parseAmount } from "@/lib/money";
import { authActionClient } from "@/lib/safe-action";
import {
  debtTermsSchema,
  deleteDebtTermsSchema,
  percentToFraction,
  refineDebtTermsAmounts,
} from "@/lib/validation/debt-terms";

// An amount arrives as a Zod-validated string; turning it into the integer the
// column keeps can only fail if the refinement above let something through it
// should not have, so a null parse is `errors.unexpected`, not a field message.
function toMinor(amount: string): number {
  const minor = parseAmount(amount);
  if (minor === null) throw new ActionError("errors.unexpected");
  return minor;
}

// The `assert_debt_terms_liability` trigger raises 23514 when the account is not
// a liability; a denied write reads the same as terms that were never there, and
// so does an account deleted under the open dialog — the policy is the account's.
// 23503 is the net under that: a reference gone after it was picked.
function mapDebtTermsError(error: unknown): never {
  const code = pgErrorCode(error);
  if (code === "42501") throw new ActionError("errors.notFound");
  if (code === "23514") throw new ActionError("debts.errors.notLiability");
  if (code === "23503") throw new ActionError("errors.referenceGone");
  throw error;
}

/**
 * Writes or rewrites the debt profile of a liability account (RF-78, RF-80). The
 * scope comes from the account through RLS, so no owner or group travels here;
 * the rate and the minimum percentage convert to their DB fractions.
 *
 * Every amount is read in the currency the account settles in, read off the
 * account and never off the payload (RF-121): a limit and a minimum are
 * denominated in what the card bills in. The rule that bounds them is the very
 * refinement the form runs, against the currency read back here (RNF-10). An
 * account the policies do not show answers no currency, and the upsert below is
 * refused by the same policy.
 */
export const saveDebtTermsAction = authActionClient
  .inputSchema(debtTermsSchema)
  .action(
    async ({
      parsedInput: {
        accountId,
        debtKind,
        annualRate,
        minimumPayment,
        minimumPaymentPct,
        creditLimit,
        statementCutOffDay,
        paymentDueDay,
        aval,
      },
    }) => {
      const settlement = await getSettlementCurrencies({
        fromAccountId: accountId,
        toAccountId: null,
      });
      const currency = settlement.from ?? BASE_CURRENCY;

      const amounts = { minimumPayment, creditLimit, aval };
      const verdict = z
        .custom<typeof amounts>()
        .superRefine(refineDebtTermsAmounts(currency))
        .safeParse(amounts);
      if (!verdict.success) throw new ActionError(verdict.error.issues[0].message);

      let savedAccountId: string;
      try {
        ({ accountId: savedAccountId } = await upsertDebtTerms({
          accountId,
          debtKind,
          annualRate: percentToFraction(annualRate),
          minimumPaymentCents:
            minimumPayment != null ? toMinor(minimumPayment) : null,
          minimumPaymentPct: minimumPaymentPct != null ? percentToFraction(minimumPaymentPct) : null,
          creditLimitCents: creditLimit != null ? toMinor(creditLimit) : null,
          statementCutOffDay: statementCutOffDay ?? null,
          paymentDueDay: paymentDueDay ?? null,
          avalCents: aval != null ? toMinor(aval) : null,
        }));
      } catch (error) {
        mapDebtTermsError(error);
      }

      refresh();
      return { accountId: savedAccountId };
    },
  );

// A denied or absent profile reports as no row (RF-78).
export const deleteDebtTermsAction = authActionClient
  .inputSchema(deleteDebtTermsSchema)
  .action(async ({ parsedInput: { accountId } }) => {
    const deleted = await deleteDebtTerms({ accountId });
    if (!deleted) throw new ActionError("errors.notFound");

    refresh();
  });
