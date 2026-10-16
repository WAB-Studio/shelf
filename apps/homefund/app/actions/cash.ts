"use server";

import { refresh } from "next/cache";
import { getLocale } from "next-intl/server";

import { withdrawCash } from "@/db/queries/cash";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { PERSONAL_CASH_ACCOUNT_NAME } from "@/lib/fund/seed";
import { DEFAULT_LOCALE, isLocale } from "@/lib/locales";
import { parseAmount } from "@/lib/money";
import { authActionClient } from "@/lib/safe-action";
import { withdrawCashSchema } from "@/lib/validation/cash";

/**
 * Withdraws cash (RF-68, RF-40). The move is a transfer from a source asset
 * account into the caller's cash, routed by `cash_mode`; a per-member or personal
 * caller with no cash yet has it created in the same transaction. The amount
 * arrives as a Zod-validated string, read in the stored scale every currency
 * shares (RF-126) — so a null parse here is a schema that let something
 * through: `errors.unexpected`, not a field message. The scope, kind, currency
 * and `created_by` are the DB's to set.
 */
export const withdrawCashAction = authActionClient
  .inputSchema(withdrawCashSchema)
  .action(async ({ parsedInput: { sourceAccountId, amount } }) => {
    const amountCents = parseAmount(amount);
    if (amountCents === null) throw new ActionError("cash.errors.amountInvalid");

    // The create-on-demand account is named in the caller's active language
    // (RF-64); it is read only when no cash exists yet.
    const locale = await getLocale();
    const cashAccountName =
      PERSONAL_CASH_ACCOUNT_NAME[isLocale(locale) ? locale : DEFAULT_LOCALE];

    try {
      const result = await withdrawCash({ sourceAccountId, amountCents, cashAccountName });
      refresh();
      return result;
    } catch (error) {
      // 42501 is a denied write, which reads the same as an account that was never
      // there — a source deleted mid-withdrawal included, since the policy names it
      // ahead of any foreign key; 23901 is a withdrawal into cash that settles in
      // another currency, refused by `0032`; 23514 is the check trigger; 23503 the
      // net under all three, a reference gone after it was picked.
      const code = pgErrorCode(error);
      if (code === "42501") throw new ActionError("errors.notFound");
      if (code === "23901") throw new ActionError("transactions.errors.currencyMismatch");
      if (code === "23514") throw new ActionError("transactions.errors.splitsScopeViolation");
      if (code === "23503") throw new ActionError("errors.referenceGone");
      throw error;
    }
  });
