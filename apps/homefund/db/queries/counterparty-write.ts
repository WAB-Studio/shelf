import "server-only";

import { sql } from "drizzle-orm";

import { mapTransactionError } from "@/db/queries/ledger-write";
import { withUserDb } from "@/db/session";
import { ActionError } from "@/lib/errors";
import { learnedPattern } from "@/lib/ingest/counterparty-pattern";
import type { CompleteCounterpartyInput } from "@/lib/validation/transaction";

// The write behind the Bandeja's «completar» and behind `/mcp`: it takes input a Zod schema already
// parsed and throws an `ActionError` carrying a catalogue key, so both doors refuse in the same words.

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
export async function completeCounterparty({
  transactionId,
  accountId,
}: CompleteCounterpartyInput): Promise<{ transactionId: string }> {
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

  return { transactionId: result.id };
}

