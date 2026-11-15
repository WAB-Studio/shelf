"use server";

import { refresh } from "next/cache";

import { sql } from "drizzle-orm";
import { returnValidationErrors } from "next-safe-action";

import { completeCounterparty } from "@/db/queries/counterparty-write";
import { bookMovement, dropMovement, reviseMovement } from "@/db/queries/ledger-write";
import { withUserDb } from "@/db/session";
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
    const { transactionId } = await bookMovement(parsedInput, () =>
      assertCauseReadable(parsedInput.causedByTransactionId, createTransactionSchema),
    );

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
    await reviseMovement(parsedInput, () =>
      assertCauseReadable(parsedInput.causedByTransactionId, updateTransactionSchema),
    );

    refresh();
  });

export const deleteTransactionAction = authActionClient
  .inputSchema(deleteTransactionSchema)
  .action(async ({ parsedInput: { transactionId } }) => {
    await dropMovement(transactionId);

    refresh();
  });

export const completeCounterpartyAction = authActionClient
  .inputSchema(completeCounterpartySchema)
  .action(async ({ parsedInput }) => {
    const completed = await completeCounterparty(parsedInput);

    refresh();
    return completed;
  });
