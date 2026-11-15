"use server";

import { refresh } from "next/cache";

import { recordStatement } from "@/db/queries/statement-write";
import { authActionClient } from "@/lib/safe-action";
import { recordAccountStatementSchema } from "@/lib/validation/account-statement";

/**
 * Records one closed statement by hand (RF-129, RF-130); the write is `recordStatement`'s, shared
 * with `/mcp`.
 */
export const recordAccountStatementAction = authActionClient
  .inputSchema(recordAccountStatementSchema)
  .action(async ({ parsedInput }) => {
    await recordStatement(parsedInput);

    refresh();
  });
