"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { saveDebtTerms } from "@/db/queries/debt-write";
import { authActionClient } from "@/lib/safe-action";
import { debtTermsSchema } from "@/lib/validation/debt-terms";

// `replace` is the form editing terms a debt already carries (RF-286): it opened on them, so what it sends is the
// person's own and overwrites them. Left out, terms found holding other values are someone else's and are kept.
const saveDebtTermsInput = debtTermsSchema.and(z.object({ replace: z.boolean().optional() }));

/**
 * Writes or rewrites the debt profile of a liability account (RF-78, RF-80); the write is
 * `saveDebtTerms`'s, shared with `/mcp`. Refused or not, the screen reloads: a stale save leaves
 * it showing the terms that landed first.
 */
export const saveDebtTermsAction = authActionClient
  .inputSchema(saveDebtTermsInput)
  .action(async ({ parsedInput: { replace, ...terms } }) => {
    try {
      return await saveDebtTerms(terms, { replace });
    } finally {
      refresh();
    }
  });
