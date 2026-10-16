"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { recordAccountStatement } from "@/db/queries/account-statements";
import { getSettlementCurrencies } from "@/db/queries/transactions";
import { BASE_CURRENCY } from "@/lib/currency";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { parseAmount } from "@/lib/money";
import { authActionClient } from "@/lib/safe-action";
import {
  recordAccountStatementSchema,
  refineAccountStatementAmounts,
} from "@/lib/validation/account-statement";

// An amount arrives as a Zod-validated string; turning it into the integer the
// column keeps can only fail if the refinement above let something through it
// should not have.
function toMinor(amount: string): number {
  const minor = parseAmount(amount);
  if (minor === null) throw new ActionError("errors.unexpected");
  return minor;
}

// A blank field stays absent: `recordAccountStatement` writes it `null`, which
// says "the statement never printed this figure" — never the zero a parsed
// empty string would otherwise read as (RF-130).
function toOptionalMinor(amount: string | null): number | null {
  return amount === null ? null : toMinor(amount);
}

// The refinement the form runs, run again here against the currency read off
// the account rather than the one the payload claims (RNF-10). The first
// issue is what the caller is told, as every other refusal in this file
// reports one.
function assertAmounts<T>(
  data: T,
  refine: (data: T, ctx: z.RefinementCtx) => void,
): void {
  const verdict = z.custom<T>().superRefine(refine).safeParse(data);
  if (!verdict.success) throw new ActionError(verdict.error.issues[0].message);
}

// The driver hangs its message off the cause chain the way it hangs its
// sqlstate: the error thrown only says which query failed.
function refusalMentions(error: unknown, fragment: string): boolean {
  let current: unknown = error;

  for (let hop = 0; hop < 5; hop++) {
    if (typeof current !== "object" || current === null) return false;

    const { message, cause } = current as { message?: unknown; cause?: unknown };
    if (typeof message === "string" && message.includes(fragment)) return true;

    current = cause;
  }

  return false;
}

// `account_statements_account_cut_off_unique` is one statement per account per
// cut-off (23505). `account_statements_period_before_cut_off` and
// `account_statements_due_after_cut_off` (23514) are the same two order checks
// the schema already ran against the payload's own dates — this is the net
// under that read, not the first one. 42501 is a denied write, which reads as
// the account being outside the caller's scope; 23503 is a reference gone
// after it was picked.
function mapStatementError(error: unknown): never {
  const code = pgErrorCode(error);

  if (code === "23505") {
    throw new ActionError("installments.errors.duplicateCutOff");
  }

  if (code === "23514") {
    if (refusalMentions(error, "account_statements_period_before_cut_off")) {
      throw new ActionError("installments.errors.periodStartAfterCutOff");
    }
    if (refusalMentions(error, "account_statements_due_after_cut_off")) {
      throw new ActionError("installments.errors.dueBeforeCutOff");
    }
    throw new ActionError("errors.unexpected");
  }

  if (code === "42501") throw new ActionError("errors.notFound");
  if (code === "23503") throw new ActionError("errors.referenceGone");

  throw error;
}

/**
 * Records one closed statement by hand (RF-129, RF-130): the source stays
 * `'recorded'`, the column's own default — that is what a person typing a
 * printed figure in means, as against the period a later slice may cut from
 * movements. The scope is the account's, through RLS: nothing about an owner
 * or a group travels here.
 *
 * Every amount is read in the currency the account settles in, read off the
 * account and never off the payload (RF-121, RNF-10).
 */
export const recordAccountStatementAction = authActionClient
  .inputSchema(recordAccountStatementSchema)
  .action(
    async ({
      parsedInput: {
        accountId,
        periodStart,
        cutOffDate,
        paymentDueDate,
        openingBalance,
        closingBalance,
        credits,
        debits,
        minimumPayment,
        interestCharged,
        feesCharged,
      },
    }) => {
      const settlement = await getSettlementCurrencies({
        fromAccountId: accountId,
        toAccountId: null,
      });
      const currency = settlement.from ?? BASE_CURRENCY;

      assertAmounts(
        {
          closingBalance,
          openingBalance,
          credits,
          debits,
          minimumPayment,
          interestCharged,
          feesCharged,
        },
        refineAccountStatementAmounts(currency),
      );

      try {
        const result = await recordAccountStatement({
          accountId,
          periodStart,
          cutOffDate,
          paymentDueDate,
          openingBalanceCents: toOptionalMinor(openingBalance),
          closingBalanceCents: toMinor(closingBalance),
          creditsCents: toOptionalMinor(credits),
          debitsCents: toOptionalMinor(debits),
          minimumPaymentCents: toOptionalMinor(minimumPayment),
          interestChargedCents: toOptionalMinor(interestCharged),
          feesChargedCents: toOptionalMinor(feesCharged),
        });

        if (result === null) throw new ActionError("errors.notFound");
      } catch (error) {
        if (error instanceof ActionError) throw error;
        mapStatementError(error);
      }

      refresh();
    },
  );
