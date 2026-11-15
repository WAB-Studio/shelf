"use server";

import { refresh } from "next/cache";
import { getLocale } from "next-intl/server";

import { withdrawToCash } from "@/db/queries/cash-write";
import { PERSONAL_CASH_ACCOUNT_NAME } from "@/lib/fund/seed";
import { DEFAULT_LOCALE, isLocale } from "@/lib/locales";
import { authActionClient } from "@/lib/safe-action";
import { withdrawCashSchema } from "@/lib/validation/cash";

/** Withdraws cash (RF-68): the create-on-demand account is named in the caller's active language (RF-64). */
export const withdrawCashAction = authActionClient
  .inputSchema(withdrawCashSchema)
  .action(async ({ parsedInput }) => {
    const locale = await getLocale();
    const cashAccountName =
      PERSONAL_CASH_ACCOUNT_NAME[isLocale(locale) ? locale : DEFAULT_LOCALE];

    const result = await withdrawToCash(parsedInput, cashAccountName);
    refresh();
    return result;
  });
