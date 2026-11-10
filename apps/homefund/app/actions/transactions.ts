"use server";

import { refresh } from "next/cache";

import { sql } from "drizzle-orm";
import { returnValidationErrors } from "next-safe-action";

import { bookMovement, dropMovement, mapTransactionError, reviseMovement } from "@/db/queries/ledger-write";
import { withUserDb } from "@/db/session";
import { ActionError } from "@/lib/errors";
import { learnedPattern } from "@/lib/ingest/counterparty-pattern";
import { authActionClient } from "@/lib/safe-action";
import {
  completeCounterpartySchema,
  createTransactionSchema,
  deleteTransactionSchema,
  updateTransactionSchema,
} from "@/lib/validation/transaction";

/**
 * A named cause must be one the caller can already see: the foreign key it
 * lands on bypasses row security on the row it references (Postgres's own
 * rule, migration 0040's note), so this is the only gate that ever runs.
 * Unreadable is a field error, not the policy refusal a write would raise —
 * `returnValidationErrors` reports it on `causedByTransactionId` and nowhere
 * else, against the very schema the caller's input was parsed with.
 */
async function assertCauseReadable(
  causedByTransactionId: string | null | undefined,
  schema: typeof createTransactionSchema | typeof updateTransactionSchema,
): Promise<void> {
  if (!causedByTransactionId) return;

  const [row] = await withUserDb((tx) =>
    tx.execute<{ id: string }>(
      sql`select id from transactions where id = ${causedByTransactionId}`,
    ),
  );

  if (!row) {
    returnValidationErrors(schema, {
      causedByTransactionId: { _errors: ["transactions.errors.causeNotFound"] },
    });
  }
}

/**
 * Records a movement (RF-17, RF-25). Which of the two accounts is null decides
 * the kind, which the DB generates; an income or expense carries splits summing
 * to its amount, a transfer none. The scope follows from the accounts, resolved
 * by the trigger and never sent. A resent `requestRef` answers with the movement
 * the first copy booked, and books nothing.
 */
export const createTransactionAction = authActionClient
  .inputSchema(createTransactionSchema)
  .action(async ({ parsedInput }) => {
    await assertCauseReadable(parsedInput.causedByTransactionId, createTransactionSchema);
    const { transactionId } = await bookMovement(parsedInput);

    refresh();
    return { ok: true as const, transactionId };
  });

/**
 * Rewrites a movement's editable fields and replaces its splits and labels
 * (RF-24). `external_ref` is immutable, so it is absent from the input; a denied
 * edit reports as no row, the same as a movement that was never there, and one
 * whose stamp someone else's save moved reports `errors.stale`.
 */
export const updateTransactionAction = authActionClient
  .inputSchema(updateTransactionSchema)
  .action(async ({ parsedInput }) => {
    await assertCauseReadable(parsedInput.causedByTransactionId, updateTransactionSchema);
    await reviseMovement(parsedInput);

    refresh();
  });

export const deleteTransactionAction = authActionClient
  .inputSchema(deleteTransactionSchema)
  .action(async ({ parsedInput: { transactionId } }) => {
    await dropMovement(transactionId);

    refresh();
  });

/**
 * Fills a one-sided movement's missing account by hand, teaching the pattern
 * that filled it (RF-132 companion, RF-133, RF-135). Two round trips, not one:
 * the first reads which side is missing and the description `counterpartyPatternKey`
 * (Module 12) needs — a pure JS function, so nothing server-side can compute it
 * for us — and the second is the write and the learning together, one
 * statement, so a completion the database keeps is a completion it also
 * learned from. Both run inside the same Postgres transaction, so a race that
 * fills the side between the two still leaves nothing half done: the second
 * statement re-checks the same side is still empty, and an emptied result there
 * is refused exactly like a movement that already carried both accounts.
 *
 * A movement eligible to complete is one-sided, which means income or expense,
 * which means it carries splits (`transactions_at_least_one_account` plus the
 * income/expense branch of `assert_transaction_splits_sum` both hold today);
 * completing it makes both accounts non-null, so the DB reads its kind as
 * `transfer`, and the very same deferred trigger then refuses a transfer that
 * still carries a split. The splits ride out with the same statement, not a
 * step of their own — the wholesale delete `updateTransaction` already runs
 * whenever a person edits a movement into a transfer by hand.
 */
export const completeCounterpartyAction = authActionClient
  .inputSchema(completeCounterpartySchema)
  .action(async ({ parsedInput: { transactionId, accountId } }) => {
    const [result] = await withUserDb(async (tx) => {
      const [row] = await tx.execute<{
        from_account_id: string | null;
        to_account_id: string | null;
        description: string | null;
      }>(sql`
        select from_account_id, to_account_id, description
        from transactions where id = ${transactionId}
      `);

      if (!row) throw new ActionError("errors.notFound");

      const side: "from" | "to" | null =
        row.from_account_id === null && row.to_account_id !== null
          ? "from"
          : row.to_account_id === null && row.from_account_id !== null
            ? "to"
            : null;

      if (side === null) {
        throw new ActionError("transactions.errors.counterpartyComplete");
      }

      const description = row.description?.trim() ?? "";
      const { key: patternKey, label: patternLabel } = learnedPattern(description);

      // A movement with no description carries no span to learn from: the
      // completion still lands, only nothing teaches `ingest_counterparties`,
      // whose own length check would otherwise refuse an empty key. `learned`
      // must be joined into the final SELECT: Postgres only guarantees a
      // data-modifying CTE (`cleared`, a DELETE) runs unreferenced — a plain
      // SELECT CTE nobody reads, calling `remember_counterparty` or not, is
      // free to be pruned and never executed at all.
      const learn =
        patternKey.length > 0
          ? sql`,
            learned as (
              select private.remember_counterparty(
                ${patternKey}, ${patternLabel}, ${side}, ${accountId}
              ) from updated
            )`
          : sql``;
      const selectResult =
        patternKey.length > 0
          ? sql`select updated.id from updated join learned on true`
          : sql`select id from updated`;

      try {
        return await tx.execute<{ id: string }>(sql`
          with updated as (
            update transactions
            set
              from_account_id = case when ${side} = 'from' then ${accountId} else from_account_id end,
              to_account_id = case when ${side} = 'to' then ${accountId} else to_account_id end,
              reviewed_at = now(),
              -- Naming the other account clears the mark, not only the review
              -- stamp: the mark is the fact, and a later reader must not find
              -- it still set on a movement that now names both sides.
              awaiting_counterparty = false,
              -- A movement that gains a source is no income: «De quién» goes with it.
              contributed_by_member_id = case when ${side} = 'from' then null else contributed_by_member_id end
            where id = ${transactionId}
              and (case when ${side} = 'from' then from_account_id else to_account_id end) is null
            returning id
          ),
          cleared as (
            delete from transaction_splits
            where transaction_id in (select id from updated)
          )${learn}
          ${selectResult}
        `);
      } catch (error) {
        mapTransactionError(error);
      }
    });

    if (!result) throw new ActionError("transactions.errors.counterpartyComplete");

    refresh();
    return { transactionId: result.id };
  });
