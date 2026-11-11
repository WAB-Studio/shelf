"use server";

import { refresh } from "next/cache";

import {
  archiveAccount,
  deleteAccount,
  handAccountToGroup,
  moveRefusalKey,
  restoreAccount,
  updateAccount,
} from "@/db/queries/accounts";
import { openAccount } from "@/db/queries/ledger-write";
import { pgConstraintName, pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { parseAmount } from "@/lib/money";
import { authActionClient } from "@/lib/safe-action";
import {
  archiveAccountSchema,
  createAccountSchema,
  deleteAccountSchema,
  handAccountToGroupSchema,
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
 * Updates an account's editable fields. `kind` and the placement are immutable,
 * so neither is part of this input (RF-09, RF-60).
 */
export const updateAccountAction = authActionClient
  .inputSchema(updateAccountSchema)
  .action(async ({ parsedInput: { amount, ...account } }) => {
    // RF-156: an edit sent without the stamp its form loaded is stale, refused before any write.
    if (!account.expectedUpdatedAt) throw new ActionError("errors.stale");
    const amountMinor = parseAmount(amount);
    if (amountMinor === null) throw new ActionError("errors.unexpected");

    let updated: Awaited<ReturnType<typeof updateAccount>>;
    try {
      updated = await updateAccount({ ...account, amountMinor });
    } catch (error) {
      // Only the leader flips `is_shared` on a group account; the trigger raises 42501.
      if (pgErrorCode(error) === "42501") throw new ActionError("errors.notLeader");
      if (pgErrorCode(error) === "23514")
        throw new ActionError("accounts.errors.currencyInvalid");
      // AC001: an account with movements or a count keeps the currency they are in.
      if (pgErrorCode(error) === "AC001")
        throw new ActionError("accounts.errors.currencyLocked");
      // RF-173: a pocket's parent must hold, and a parent keeps what its pockets were opened in.
      if (pgErrorCode(error) === "PK001") throw new ActionError("accounts.errors.parentInvalid");
      if (pgErrorCode(error) === "PK002") throw new ActionError("accounts.errors.hasPockets");
      throw error;
    }
    if (updated === "stale") throw new ActionError("errors.stale");
    if (!updated) throw new ActionError("errors.notFound");

    refresh();
  });

export const archiveAccountAction = authActionClient
  .inputSchema(archiveAccountSchema)
  .action(async ({ parsedInput: { accountId } }) => {
    let archived: boolean;
    try {
      archived = await archiveAccount({ accountId });
    } catch (error) {
      // PK002: an account with live pockets stays (RF-173).
      if (pgErrorCode(error) === "PK002") throw new ActionError("accounts.errors.hasPockets");
      throw error;
    }
    if (!archived) throw new ActionError("errors.notFound");

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
 * which any member may write it. Each refusal the database raises names why; see `moveRefusalKey`.
 */
export const handAccountToGroupAction = authActionClient
  .inputSchema(handAccountToGroupSchema)
  .action(async ({ parsedInput: { accountId } }) => {
    try {
      await handAccountToGroup({ accountId });
    } catch (error) {
      const key = moveRefusalKey(error);
      if (key) throw new ActionError(key);
      throw error;
    }

    refresh();
  });

/**
 * Deletes an account outright. Once movements reference accounts, deleting
 * one that has them will trip the foreign key (23503) before it trips a
 * row count. This is the one 23503 in the app raised BY an account rather than
 * ON one, so it names the movements and points at archiving instead (RF-11).
 */
export const deleteAccountAction = authActionClient
  .inputSchema(deleteAccountSchema)
  .action(async ({ parsedInput: { accountId } }) => {
    let deleted: boolean;
    try {
      deleted = await deleteAccount({ accountId });
    } catch (error) {
      // The foreign key a pocket holds on its parent: an account with pockets stays (RF-173).
      if (pgConstraintName(error) === "accounts_parent_account_id_accounts_id_fk")
        throw new ActionError("accounts.errors.hasPockets");
      if (pgErrorCode(error) === "23503")
        throw new ActionError("errors.accountHasMovements");
      throw error;
    }
    if (!deleted) throw new ActionError("errors.notFound");

    refresh();
  });
