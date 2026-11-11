import "server-only";

import { sql } from "drizzle-orm";

import { insertRow } from "@/db/insert-row";
import { transactions } from "@/db/schema";
import type { Account } from "@/db/schema";
import { withUserDb } from "@/db/session";
import { pgErrorCode } from "@/lib/db-error";

/**
 * The refusal a payment gets when the accounts it names are the wrong kinds. It
 * carries the sqlstate a check constraint would have carried, because that is
 * what the action layer reads off the cause chain — the guard is only decided a
 * statement earlier, before anything is written.
 */
class DebtPaymentRefusal extends Error {
  readonly code = "23514";
}

/**
 * A payment against a liability (RF-16) in ONE `withUserDb`, two round trips: the
 * kinds guard, so the refusal lands BEFORE anything is written, and the transfer
 * that credits the liability, in the ledger's own transfer shape (scope, kind and
 * created_by fall to triggers). It allocates nothing: the balance is derived from
 * movements, and an instalment is only a share of the minimum (RF-136).
 *
 * A resent `requestRef` raises 23505 on the insert, as `createTransaction` does,
 * and the resend answers with the movement the first copy booked.
 */
export async function recordDebtPayment({
  fromAccountId,
  toAccountId,
  amountCents,
  occurredAt,
  requestRef,
}: {
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  occurredAt: string;
  requestRef?: string;
}): Promise<{ transactionId: string }> {
  const externalRef = requestRef ? `form:${requestRef}` : null;

  try {
    return await withUserDb(async (tx) => {
      const [kinds] = await tx.execute<{
        from_kind: Account["kind"] | null;
        to_kind: Account["kind"] | null;
      }>(sql`
        select
          (select a.kind from accounts a where a.id = ${fromAccountId}) as from_kind,
          (select a.kind from accounts a where a.id = ${toAccountId}) as to_kind
      `);

      // A kind that came back null is an account the policies did not show: the
      // insert below answers that with 42501, the refusal the caller already reads.
      if (kinds.from_kind !== null && kinds.from_kind !== "asset") {
        throw new DebtPaymentRefusal("a debt payment comes from an asset account");
      }
      if (kinds.to_kind !== null && kinds.to_kind !== "liability") {
        throw new DebtPaymentRefusal("a debt payment credits a liability account");
      }

      // `created_by`, the scope and `kind` are set by triggers/generation and
      // absent from the INSERT grant.
      const [txn] = await insertRow(
        tx,
        transactions,
        { fromAccountId, toAccountId, amountCents, occurredAt, externalRef },
        { returning: { id: transactions.id } },
      );

      return { transactionId: txn.id };
    });
  } catch (error) {
    if (!externalRef || pgErrorCode(error) !== "23505") throw error;

    // The debt names the scope the first copy was booked in, so the ref is read there alone.
    const [existing] = await withUserDb((tx) =>
      tx.execute<{ id: string }>(sql`
        select t.id from transactions t
        where t.external_ref = ${externalRef} and t.to_account_id = ${toAccountId}
        limit 1
      `),
    );
    if (!existing) throw error;

    return { transactionId: existing.id };
  }
}
