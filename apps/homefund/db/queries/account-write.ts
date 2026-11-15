import "server-only";

import { archiveAccount, deleteAccount, updateAccount } from "@/db/queries/accounts";
import { pgConstraintName, pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { parseAmount } from "@/lib/money";
import type { UpdateAccountInput } from "@/lib/validation/account";

// The writes behind the account forms' actions and behind `/mcp`: each takes input a Zod schema already
// parsed and throws an `ActionError` carrying a catalogue key, so both doors refuse in the same words.

/**
 * Updates an account's editable fields. `kind` and the placement are immutable: both ride
 * in the input only so the schema's rules judge the edit, and neither is written (RF-09, RF-60).
 */
export async function reviseAccount({ amount, ...account }: UpdateAccountInput): Promise<void> {
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
    if (pgErrorCode(error) === "23514") throw new ActionError("accounts.errors.currencyInvalid");
    // AC001: an account with movements or a count keeps the currency they are in.
    if (pgErrorCode(error) === "AC001") throw new ActionError("accounts.errors.currencyLocked");
    // RF-173: a pocket's parent must hold, and a parent keeps what its pockets were opened in.
    if (pgErrorCode(error) === "PK001") throw new ActionError("accounts.errors.parentInvalid");
    if (pgErrorCode(error) === "PK002") throw new ActionError("accounts.errors.hasPockets");
    throw error;
  }
  if (updated === "stale") throw new ActionError("errors.stale");
  if (!updated) throw new ActionError("errors.notFound");
}

/** Archives an account (RF-11); one with live pockets stays. */
export async function retireAccount({ accountId }: { accountId: string }): Promise<void> {
  let archived: boolean;
  try {
    archived = await archiveAccount({ accountId });
  } catch (error) {
    // PK002: an account with live pockets stays (RF-173).
    if (pgErrorCode(error) === "PK002") throw new ActionError("accounts.errors.hasPockets");
    throw error;
  }
  if (!archived) throw new ActionError("errors.notFound");
}

/**
 * Deletes an account outright. Once movements reference accounts, deleting
 * one that has them will trip the foreign key (23503) before it trips a
 * row count. This is the one 23503 in the app raised BY an account rather than
 * ON one, so it names the movements and points at archiving instead (RF-11).
 */
export async function removeAccount({ accountId }: { accountId: string }): Promise<void> {
  let deleted: boolean;
  try {
    deleted = await deleteAccount({ accountId });
  } catch (error) {
    // The foreign key a pocket holds on its parent: an account with pockets stays (RF-173).
    if (pgConstraintName(error) === "accounts_parent_account_id_accounts_id_fk")
      throw new ActionError("accounts.errors.hasPockets");
    if (pgErrorCode(error) === "23503") throw new ActionError("errors.accountHasMovements");
    throw error;
  }
  if (!deleted) throw new ActionError("errors.notFound");
}
