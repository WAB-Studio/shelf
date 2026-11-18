import "server-only";

import { sql } from "drizzle-orm";

import { archiveAccount, deleteAccount, updateAccount } from "@/db/queries/accounts";
import { withUserDb } from "@/db/session";
import { pgConstraintName, pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { parseAmount } from "@/lib/money";
import type { FindLaterOpeningInput, MoveOpeningEarlierInput, UpdateAccountInput } from "@/lib/validation/account";

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

export type LaterOpening = { accountId: string; name: string; kind: "asset" | "liability"; openedOn: string };

/**
 * The account a movement dated `occurredAt` would be refused by (RF-162): the first of `accountIds`, in the order
 * given, that the caller may write and whose opening falls after that day. Null when none does, so the screen says
 * nothing it cannot do. ONE statement; the policies show only what the caller reads.
 */
export async function findLaterOpening({ accountIds, occurredAt }: FindLaterOpeningInput): Promise<LaterOpening | null> {
  const rows = await withUserDb((tx) =>
    tx.execute<LaterOpening>(sql`
      select a.id as "accountId", a.name, a.kind, a.initial_balance_on::text as "openedOn"
      from accounts a
      where a.id in (${sql.join(accountIds.map((id) => sql`${id}::uuid`), sql`, `)})
        and a.initial_balance_on > ${occurredAt}::date and private.can_write_account(a.id)
      order by array_position(array[${sql.join(accountIds.map((id) => sql`${id}::uuid`), sql`, `)}], a.id)
      limit 1`),
  );
  return rows[0] ?? null;
}

/**
 * Moves an account's opening back to `occurredAt` (RF-303), the opening amount staying what it was: nothing moved
 * between the two days, so it is true on the earlier one too. Never moves an opening later, which could cross a
 * movement (MO002). Refuses what the caller cannot write or an account already open that day.
 */
export async function startAccountEarlier({ accountId, occurredAt }: MoveOpeningEarlierInput): Promise<void> {
  const rows = await withUserDb((tx) =>
    tx.execute<{ id: string }>(sql`
      update accounts set initial_balance_on = ${occurredAt}::date
      where id = ${accountId}::uuid and initial_balance_on > ${occurredAt}::date
      returning id`),
  );
  if (rows.length === 0) throw new ActionError("errors.notFound");
}
