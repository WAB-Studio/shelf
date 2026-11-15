"use server";

import { refresh } from "next/cache";

import { recordBilled } from "@/db/queries/statement-write";
import { authActionClient } from "@/lib/safe-action";
import { recordBilledAmountSchema } from "@/lib/validation/debt-settlement";

/**
 * Writes what the issuer billed for one foreign-currency purchase (RF-123); the write is
 * `recordBilled`'s, shared with `/mcp`.
 */
export const recordBilledAmountAction = authActionClient
  .inputSchema(recordBilledAmountSchema)
  .action(async ({ parsedInput }) => {
    await recordBilled(parsedInput);

    refresh();
  });
