"use server";

import { refresh } from "next/cache";

import { saveDebtTerms } from "@/db/queries/debt-write";
import { authActionClient } from "@/lib/safe-action";
import { debtTermsSchema } from "@/lib/validation/debt-terms";

/**
 * Writes or rewrites the debt profile of a liability account (RF-78, RF-80); the write is
 * `saveDebtTerms`'s, shared with `/mcp`. Refused or not, the screen reloads: a stale save leaves
 * it showing the terms that landed first.
 */
export const saveDebtTermsAction = authActionClient
  .inputSchema(debtTermsSchema)
  .action(async ({ parsedInput }) => {
    try {
      return await saveDebtTerms(parsedInput);
    } finally {
      refresh();
    }
  });
