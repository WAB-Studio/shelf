"use server";

import { refresh } from "next/cache";

import { sql } from "drizzle-orm";
import { returnValidationErrors } from "next-safe-action";
import { z } from "zod";

import {
  createTransaction,
  deleteTransaction,
  getSettlementCurrencies,
  updateTransaction,
} from "@/db/queries/transactions";
import type { TransactionSplitInput } from "@/db/queries/transactions";
import { withUserDb } from "@/db/session";
import { BASE_CURRENCY, type CurrencyCode } from "@/lib/currency";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { counterpartyPatternKey } from "@/lib/ingest/counterparty-pattern";
import { parseAmount } from "@/lib/money";
import { authActionClient } from "@/lib/safe-action";
import {
  completeCounterpartySchema,
  createTransactionSchema,
  deleteTransactionSchema,
  foreignSettlementCurrency,
  refineSettlement,
  updateTransactionSchema,
} from "@/lib/validation/transaction";

// `ingest_counterparties.pattern_key`/`pattern_label` both cap at 120 (migration
// 0041); a movement's own description can run to 200, so the span is capped
// here rather than let a long note refuse the very completion that produced it.
const PATTERN_FIELD_MAX = 120;

type SplitInput = { categoryId: string; amount: string };

// The amount and each split arrive as Zod-validated strings, already bound to
// the stored scale by the schema; turning them into integers here can only
// fail if the schema let something through it should not have, so a null
// parse is `errors.unexpected`, not a field message.
function toMinor(amount: string): number {
  const minor = parseAmount(amount);
  if (minor === null) throw new ActionError("errors.unexpected");
  return minor;
}

function toSplitMinor(splits: SplitInput[]): TransactionSplitInput[] {
  return splits.map((split) => ({
    categoryId: split.categoryId,
    amountCents: toMinor(split.amount),
  }));
}

// What a movement carries beside its own amount: the second figure, in the
// minor unit of the account that settles elsewhere, and the mark that says a
// statement has not confirmed it yet (RF-122, RF-123).
type CounterAmount = { counterAmountCents: number | null; counterIsEstimate: boolean };

/**
 * Reads the second amount in the currency the accounts declare, never the one
 * the payload claims. The read only happens when there is a second amount to
 * place: a movement in its account's own currency is the common case and pays
 * nothing for this. The rule that decides required-or-forbidden is the very
 * refinement the form runs, against the currencies read back here (RNF-10);
 * what it does not see — a foreign account whose second amount never arrived —
 * the `transactions_verify_currency` trigger refuses on its own.
 */
async function resolveCounterAmount(movement: {
  fromAccountId: string | null;
  toAccountId: string | null;
  currency?: CurrencyCode;
  counterAmount?: string | null;
  counterIsEstimate?: boolean;
}): Promise<CounterAmount> {
  const counter = movement.counterAmount?.trim() ? movement.counterAmount : null;
  if (counter === null) {
    return { counterAmountCents: null, counterIsEstimate: false };
  }

  const settlement = await getSettlementCurrencies(movement);
  const verdict = z
    .custom<typeof movement>()
    .superRefine(refineSettlement(settlement))
    .safeParse(movement);

  if (!verdict.success) throw new ActionError(verdict.error.issues[0].message);

  const foreign = foreignSettlementCurrency(
    movement.currency ?? BASE_CURRENCY,
    settlement,
  );
  if (foreign === null) throw new ActionError("errors.unexpected");

  return {
    counterAmountCents: toMinor(counter),
    counterIsEstimate: movement.counterIsEstimate ?? false,
  };
}

// `transactions_verify_currency` raises this and nothing else does: a movement
// whose currency does not agree with the accounts it names (migration `0032`).
const CURRENCY_REFUSAL = "23901";

// The scope, `kind` and `created_by` are the DB's to set, so none travels in the
// payload. 23514 is left to what it has always meant here — the split, scope and
// placement triggers, and the column checks; a denied write raises 42501, which
// reads the same as a movement that was never there — an account deleted under
// the open form lands there, since the INSERT policy runs before any foreign key.
// What is left for 23503 is a reference the row names that vanished after it was
// picked.
function mapTransactionError(error: unknown): never {
  const code = pgErrorCode(error);
  if (code === "42501") throw new ActionError("errors.notFound");
  if (code === CURRENCY_REFUSAL) {
    throw new ActionError("transactions.errors.currencyMismatch");
  }
  if (code === "23514") throw new ActionError("transactions.errors.splitsScopeViolation");
  if (code === "23503") throw new ActionError("errors.referenceGone");
  throw error;
}

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

// `caused_by_transaction_id` rides its own column grant (migration 0040), so it
// is written here, once the movement itself already exists, rather than inside
// the shared insert/update path: a follow-up statement on a row this same call
// just proved writable, always run to let an edit clear a cause as freely as it
// sets one.
async function setCause(
  transactionId: string,
  causedByTransactionId: string | null | undefined,
): Promise<void> {
  try {
    await withUserDb((tx) =>
      tx.execute(sql`
        update transactions set caused_by_transaction_id = ${causedByTransactionId ?? null}
        where id = ${transactionId}
      `),
    );
  } catch (error) {
    mapTransactionError(error);
  }
}

/**
 * Records a movement (RF-17, RF-25). Which of the two accounts is null decides
 * the kind, which the DB generates; an income or expense carries splits summing
 * to its amount, a transfer none. The scope follows from the accounts, resolved
 * by the trigger and never sent.
 */
export const createTransactionAction = authActionClient
  .inputSchema(createTransactionSchema)
  .action(async ({ parsedInput }) => {
    await assertCauseReadable(parsedInput.causedByTransactionId, createTransactionSchema);
    const counter = await resolveCounterAmount(parsedInput);

    let transactionId: string;
    try {
      ({ transactionId } = await createTransaction({
        fromAccountId: parsedInput.fromAccountId,
        toAccountId: parsedInput.toAccountId,
        amountCents: toMinor(parsedInput.amount),
        currency: parsedInput.currency ?? null,
        ...counter,
        occurredAt: parsedInput.occurredAt,
        description: parsedInput.description,
        externalRef: parsedInput.externalRef ?? null,
        splits: toSplitMinor(parsedInput.splits),
        labelIds: parsedInput.labelIds,
      }));
    } catch (error) {
      mapTransactionError(error);
    }

    if (parsedInput.causedByTransactionId) {
      await setCause(transactionId, parsedInput.causedByTransactionId);
    }

    refresh();
    return { transactionId };
  });

/**
 * Rewrites a movement's editable fields and replaces its splits and labels
 * (RF-24). `external_ref` is immutable, so it is absent from the input; a denied
 * edit reports as no row, the same as a movement that was never there.
 */
export const updateTransactionAction = authActionClient
  .inputSchema(updateTransactionSchema)
  .action(async ({ parsedInput }) => {
    await assertCauseReadable(parsedInput.causedByTransactionId, updateTransactionSchema);
    const counter = await resolveCounterAmount(parsedInput);

    let updated: Awaited<ReturnType<typeof updateTransaction>>;
    try {
      updated = await updateTransaction({
        transactionId: parsedInput.transactionId,
        fromAccountId: parsedInput.fromAccountId,
        toAccountId: parsedInput.toAccountId,
        amountCents: toMinor(parsedInput.amount),
        currency: parsedInput.currency ?? null,
        ...counter,
        occurredAt: parsedInput.occurredAt,
        description: parsedInput.description,
        splits: toSplitMinor(parsedInput.splits),
        labelIds: parsedInput.labelIds,
        // Wholesale: an edit clearing the cause sends `null`, and absent means none.
        causedByTransactionId: parsedInput.causedByTransactionId ?? null,
      });
    } catch (error) {
      mapTransactionError(error);
    }

    if (updated === "adjustment") throw new ActionError("errors.adjustmentReadOnly");
    if (updated === "missing") throw new ActionError("errors.notFound");

    refresh();
  });

// The cascade removes the splits and label joins; a false row count is a denied
// or absent movement (RF-24).
export const deleteTransactionAction = authActionClient
  .inputSchema(deleteTransactionSchema)
  .action(async ({ parsedInput: { transactionId } }) => {
    const deleted = await deleteTransaction({ transactionId });
    if (deleted === "adjustment") throw new ActionError("errors.adjustmentReadOnly");
    if (deleted === "missing") throw new ActionError("errors.notFound");

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
      const patternKey = counterpartyPatternKey(description).slice(0, PATTERN_FIELD_MAX);
      const patternLabel = description.slice(0, PATTERN_FIELD_MAX);

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
              awaiting_counterparty = false
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
