"use server";

import { refresh } from "next/cache";

import { handAccountToGroup, restoreAccount } from "@/db/queries/accounts";
import { findLaterOpening, removeAccount, retireAccount, reviseAccount, startAccountEarlier } from "@/db/queries/account-write";
import { openAccount } from "@/db/queries/ledger-write";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import {
  archiveAccountSchema,
  createAccountSchema,
  deleteAccountSchema,
  findLaterOpeningSchema,
  handAccountToGroupSchema,
  moveOpeningEarlierSchema,
  restoreAccountSchema,
  updateAccountSchema,
} from "@/lib/validation/account";

/**
 * Creates an account (RF-60, RF-09, RF-10, RF-121); the write is `openAccount`'s, shared with `/mcp`.
 */
export const createAccountAction = authActionClient
  .inputSchema(createAccountSchema)
  .action(async ({ parsedInput, ctx }) => {
    const created = await openAccount(parsedInput, ctx.user.id);

    refresh();
    return created;
  });

/**
 * Updates an account's editable fields (RF-09, RF-60); the write is `reviseAccount`'s, shared with `/mcp`.
 */
export const updateAccountAction = authActionClient
  .inputSchema(updateAccountSchema)
  .action(async ({ parsedInput }) => {
    await reviseAccount(parsedInput);

    refresh();
  });

/**
 * Which account a movement dated before its opening was refused by, for «¿Empezó antes?» (RF-303); a read, so it
 * refreshes nothing.
 */
export const findLaterOpeningAction = authActionClient
  .inputSchema(findLaterOpeningSchema)
  .action(async ({ parsedInput }) => findLaterOpening(parsedInput));

/** Moves an account's opening back to the day of a movement it refused (RF-303), so the movement can be saved. */
export const moveOpeningEarlierAction = authActionClient
  .inputSchema(moveOpeningEarlierSchema)
  .action(async ({ parsedInput }) => {
    await startAccountEarlier(parsedInput);

    refresh();
  });

export const archiveAccountAction = authActionClient
  .inputSchema(archiveAccountSchema)
  .action(async ({ parsedInput }) => {
    await retireAccount(parsedInput);

    refresh();
  });

export const restoreAccountAction = authActionClient
  .inputSchema(restoreAccountSchema)
  .action(async ({ parsedInput: { accountId } }) => {
    const restored = await restoreAccount({ accountId });
    if (!restored) throw new ActionError("errors.notFound");

    refresh();
  });

/**
 * Moves a personal account into the caller's fund with its whole history (RF-61, RF-180), after
 * which any member may write it. `handAccountToGroup` throws each refusal as an `ActionError`.
 */
export const handAccountToGroupAction = authActionClient
  .inputSchema(handAccountToGroupSchema)
  .action(async ({ parsedInput: { accountId } }) => {
    await handAccountToGroup({ accountId });

    refresh();
  });

/**
 * Deletes an account outright (RF-11); the write is `removeAccount`'s, shared with `/mcp`.
 */
export const deleteAccountAction = authActionClient
  .inputSchema(deleteAccountSchema)
  .action(async ({ parsedInput }) => {
    await removeAccount(parsedInput);

    refresh();
  });
