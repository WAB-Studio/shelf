import "server-only";

import { deleteAccountStatement, recordAccountStatement, reviseAccountStatement } from "@/db/queries/account-statements";
import { createDeferral, deleteDeferral } from "@/db/queries/deferrals";
import { BilledAmountRefused, recordBilledAmount } from "@/db/queries/debt-statements";
import { getSettlementCurrencies } from "@/db/queries/transactions";
import { assertRefined, requireMinor } from "@/lib/action-amounts";
import { BASE_CURRENCY } from "@/lib/currency";
import { pgErrorCode, pgErrorMentions } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { parseAmount } from "@/lib/money";
import {
  type RecordAccountStatementInput,
  type ReviseAccountStatementInput,
  refineAccountStatementAmounts,
} from "@/lib/validation/account-statement";
import type { RecordBilledAmountInput } from "@/lib/validation/debt-settlement";
import type { DeferPurchaseInput } from "@/lib/validation/deferral";

// The writes behind the statement, billed-amount and deferral actions and behind `/mcp`: each takes
// input a Zod schema already parsed and throws an `ActionError` carrying a catalogue key, so both
// doors refuse in the same words.

// A blank field stays absent: `recordAccountStatement` writes it `null`, which
// says "the statement never printed this figure" — never the zero a parsed
// empty string would otherwise read as (RF-130).
function toOptionalMinor(amount: string | null): number | null {
  return amount === null ? null : requireMinor(amount);
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
    if (pgErrorMentions(error, "account_statements_period_before_cut_off")) {
      throw new ActionError("installments.errors.periodStartAfterCutOff");
    }
    if (pgErrorMentions(error, "account_statements_due_after_cut_off")) {
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
export async function recordStatement({
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
}: RecordAccountStatementInput): Promise<void> {
  const settlement = await getSettlementCurrencies({
    fromAccountId: accountId,
    toAccountId: null,
  });
  const currency = settlement.from ?? BASE_CURRENCY;

  assertRefined(
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
      closingBalanceCents: requireMinor(closingBalance),
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
}

/**
 * Corrects the LAST statement of an account (RF-284). The policy admits no other, so a statement that is not
 * the last, one already gone and one outside the caller's scope all answer `errors.notFound`.
 */
export async function reviseStatement({ statementId, ...input }: ReviseAccountStatementInput): Promise<void> {
  const settlement = await getSettlementCurrencies({ fromAccountId: input.accountId, toAccountId: null });
  assertRefined(
    {
      closingBalance: input.closingBalance,
      openingBalance: input.openingBalance,
      credits: input.credits,
      debits: input.debits,
      minimumPayment: input.minimumPayment,
      interestCharged: input.interestCharged,
      feesCharged: input.feesCharged,
    },
    refineAccountStatementAmounts(settlement.from ?? BASE_CURRENCY),
  );

  let change: Awaited<ReturnType<typeof reviseAccountStatement>>;
  try {
    change = await reviseAccountStatement({
      statementId,
      accountId: input.accountId,
      periodStart: input.periodStart,
      cutOffDate: input.cutOffDate,
      paymentDueDate: input.paymentDueDate,
      openingBalanceCents: toOptionalMinor(input.openingBalance),
      closingBalanceCents: requireMinor(input.closingBalance),
      creditsCents: toOptionalMinor(input.credits),
      debitsCents: toOptionalMinor(input.debits),
      minimumPaymentCents: toOptionalMinor(input.minimumPayment),
      interestChargedCents: toOptionalMinor(input.interestCharged),
      feesChargedCents: toOptionalMinor(input.feesCharged),
    });
  } catch (error) {
    mapStatementError(error);
  }

  if (change === "beforePrevious") throw new ActionError("installments.errors.cutOffBeforePrevious");
  if (change === "missing") throw new ActionError("errors.notFound");
}

/** Takes back the LAST statement of an account (RF-284). */
export async function removeStatement(args: { accountId: string; statementId: string }): Promise<void> {
  let change: Awaited<ReturnType<typeof deleteAccountStatement>>;
  try {
    change = await deleteAccountStatement(args);
  } catch (error) {
    mapStatementError(error);
  }
  if (change !== "done") throw new ActionError("errors.notFound");
}

/**
 * Writes what the issuer billed for one foreign-currency purchase (RF-123). The
 * amount arrives as the string the schema validated in the account's settlement
 * currency; the estimate it replaces is not kept anywhere, and no balance is
 * written — clearing the mark is what moves the figure between the account's
 * pockets, and `account_balances` derives the rest (RNF-07).
 *
 * The scope is the account's, through RLS: nothing about an owner or a group
 * travels here.
 */
export async function recordBilled({
  transactionId,
  accountId,
  currency,
  billedAmount,
}: RecordBilledAmountInput): Promise<void> {
  // The schema already parsed this string, and the parse lands in the scale
  // the column keeps; a null here means the schema let through something it
  // should not have, which is not a field message.
  const billedCents = parseAmount(billedAmount);
  if (billedCents === null) throw new ActionError("errors.unexpected");

  let replaced: boolean;
  try {
    replaced = await recordBilledAmount({
      transactionId,
      accountId,
      currency,
      billedCents,
    });
  } catch (error) {
    if (error instanceof BilledAmountRefused) {
      throw new ActionError("debts.errors.beforeReconciliation");
    }
    // The UPDATE grant is column-scoped, so a caller outside it takes 42501
    // rather than the empty answer a denied policy gives.
    if (pgErrorCode(error) === "42501") {
      throw new ActionError("errors.notFound");
    }
    throw error;
  }

  // No row answered: the movement is not this card's, was billed already, or
  // the policies would not write it. One shape for the three.
  if (!replaced) throw new ActionError("errors.notFound");
}

// A person's confirmation that a purchase on a card was deferred (RF-136). Only a purchase whose
// source is a liability account can be; an absent or hidden movement reads the same way.
export async function deferPurchase({ transactionId, instalments }: DeferPurchaseInput): Promise<void> {
  try {
    if (!(await createDeferral({ transactionId, instalments }))) {
      throw new ActionError("deferrals.errors.notPurchase");
    }
  } catch (error) {
    // 23505: the movement already carries one; changing the count is remove and defer again.
    if (pgErrorCode(error) === "23505") throw new ActionError("deferrals.errors.alreadyDeferred");
    // 42501: a movement of another member's account.
    if (pgErrorCode(error) === "42501") throw new ActionError("errors.notFound");
    throw error;
  }
}

/** Removes a purchase's deferral (RF-136). */
export async function undeferPurchase({ transactionId }: { transactionId: string }): Promise<void> {
  if (!(await deleteDeferral({ transactionId }))) throw new ActionError("errors.notFound");
}
