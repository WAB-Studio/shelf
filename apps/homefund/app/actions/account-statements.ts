"use server";

import { refresh } from "next/cache";

import { recordStatement, removeStatement, reviseStatement } from "@/db/queries/statement-write";
import { authActionClient } from "@/lib/safe-action";
import {
  deleteAccountStatementSchema,
  recordAccountStatementSchema,
  reviseAccountStatementSchema,
} from "@/lib/validation/account-statement";

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

/** Corrects the last statement of an account (RF-284); the write is `reviseStatement`'s. */
export const reviseAccountStatementAction = authActionClient
  .inputSchema(reviseAccountStatementSchema)
  .action(async ({ parsedInput }) => {
    await reviseStatement(parsedInput);

    refresh();
  });

/** Takes back the last statement of an account (RF-284); the write is `removeStatement`'s. */
export const deleteAccountStatementAction = authActionClient
  .inputSchema(deleteAccountStatementSchema)
  .action(async ({ parsedInput }) => {
    await removeStatement(parsedInput);

    refresh();
  });
