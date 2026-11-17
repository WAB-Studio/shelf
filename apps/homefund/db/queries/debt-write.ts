import "server-only";

import { z } from "zod";

import { upsertDebtTerms } from "@/db/queries/debt-terms";
import { recordDebtPayment } from "@/db/queries/installment-plans";
import { getSettlementCurrencies } from "@/db/queries/transactions";
import { assertRefined, requireMinor } from "@/lib/action-amounts";
import { BASE_CURRENCY } from "@/lib/currency";
import { pgErrorCode, pgErrorMentions } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import {
  type DebtTermsInput,
  percentToFraction,
  refineDebtTermsAmounts,
} from "@/lib/validation/debt-terms";
import {
  type RecordDebtPaymentInput,
  refineDebtPaymentAmount,
} from "@/lib/validation/installment-plan";

// The writes behind the debt forms' actions and behind `/mcp`: each takes input a Zod schema already
// parsed and throws an `ActionError` carrying a catalogue key, so both doors refuse in the same words.

// The `assert_debt_terms_liability` trigger raises 23514 when the account is not
// a liability; a denied write reads the same as terms that were never there, and
// so does an account deleted under the open dialog — the policy is the account's.
// 23503 is the net under that: a reference gone after it was picked.
function mapDebtTermsError(error: unknown): never {
  const code = pgErrorCode(error);
  if (code === "42501") throw new ActionError("errors.notFound");
  if (code === "23514") throw new ActionError("debts.errors.notLiability");
  if (code === "23503") throw new ActionError("errors.referenceGone");
  throw error;
}

/**
 * Writes or rewrites the debt profile of a liability account (RF-78, RF-80). The
 * scope comes from the account through RLS, so no owner or group travels here;
 * the rate and the minimum percentage convert to their DB fractions.
 *
 * Every amount is read in the currency the account settles in, read off the
 * account and never off the payload (RF-121): a limit and a minimum are
 * denominated in what the card bills in. The rule that bounds them is the very
 * refinement the form runs, against the currency read back here (RNF-10). An
 * account the policies do not show answers no currency, and the upsert below is
 * refused by the same policy.
 *
 * Terms already holding other values are someone else's and are refused as stale, unless `replace` says
 * the caller read newer ones off a later statement and means to overwrite them.
 */
export async function saveDebtTerms(
  {
    accountId,
    debtKind,
    annualRate,
    minimumPayment,
    minimumPaymentPct,
    creditLimit,
    statementCutOffDay,
    paymentDueDay,
    termMonths,
    aval,
  }: DebtTermsInput,
  { replace = false }: { replace?: boolean } = {},
): Promise<{ accountId: string }> {
  const settlement = await getSettlementCurrencies({
    fromAccountId: accountId,
    toAccountId: null,
  });
  const currency = settlement.from ?? BASE_CURRENCY;

  const amounts = { minimumPayment, creditLimit, aval };
  const verdict = z
    .custom<typeof amounts>()
    .superRefine(refineDebtTermsAmounts(currency))
    .safeParse(amounts);
  if (!verdict.success) throw new ActionError(verdict.error.issues[0].message);

  let saved: Awaited<ReturnType<typeof upsertDebtTerms>>;
  try {
    saved = await upsertDebtTerms({
      accountId,
      debtKind,
      annualRate: percentToFraction(annualRate),
      minimumPaymentCents: minimumPayment != null ? requireMinor(minimumPayment) : null,
      minimumPaymentPct: minimumPaymentPct != null ? percentToFraction(minimumPaymentPct) : null,
      creditLimitCents: creditLimit != null ? requireMinor(creditLimit) : null,
      statementCutOffDay: statementCutOffDay ?? null,
      paymentDueDay: paymentDueDay ?? null,
      termMonths,
      avalCents: aval != null ? requireMinor(aval) : null,
      // The form writes terms onto a debt that had none (RF-156): any found are someone else's.
      keepOthers: replace ? undefined : true,
    });
  } catch (error) {
    mapDebtTermsError(error);
  }

  if (saved === "stale") throw new ActionError("errors.stale");
  return { accountId: saved.accountId };
}

// The query's own kinds guard, both halves of it, raised before anything is written.
const ASSET_SOURCE_REFUSAL = "comes from an asset account";
const LIABILITY_TARGET_REFUSAL = "credits a liability account";

// Two refusals share 23514: the two halves of the kinds guard above, told apart by the message and
// each answered with its own key; anything else the constraint refuses reads as an invalid payment. A
// movement into another member's account — or into one just deleted — is denied by RLS (42501) and
// reads as absent. 23503 is the net under that: a reference gone after it was picked.
function mapPaymentError(error: unknown): never {
  const code = pgErrorCode(error);
  if (code === "42501") throw new ActionError("errors.notFound");
  // A source and a debt that settle in different currencies: the movement would
  // carry a rate, and this path names no second amount for it (migration `0032`).
  if (code === "23901") throw new ActionError("transactions.errors.currencyMismatch");
  if (code === "23514") {
    if (pgErrorMentions(error, ASSET_SOURCE_REFUSAL)) {
      throw new ActionError("installments.errors.notFromAsset");
    }
    if (pgErrorMentions(error, LIABILITY_TARGET_REFUSAL)) {
      throw new ActionError("installments.errors.notLiability");
    }
    throw new ActionError("installments.errors.paymentInvalid");
  }
  if (code === "23503") throw new ActionError("errors.referenceGone");
  throw error;
}

/**
 * Records a payment that credits a liability from an asset (RF-16). The
 * transfer's scope and kind fall to triggers.
 *
 * The amount is read in the currency the SOURCE settles in, which is the one
 * `set_transaction_currency` books the movement in (RF-121). A source and a debt
 * that settle in different currencies make a movement that carries a rate, which
 * this path names no second amount for: `transactions_verify_currency` refuses
 * it, and the refusal maps above.
 *
 * A resent `requestRef` answers with the movement the first copy booked.
 */
export async function payDebt({
  fromAccountId,
  toAccountId,
  amount,
  occurredAt,
  requestRef,
}: RecordDebtPaymentInput): Promise<{ transactionId: string }> {
  const settlement = await getSettlementCurrencies({ fromAccountId, toAccountId });
  const currency = settlement.from ?? BASE_CURRENCY;

  assertRefined({ amount }, refineDebtPaymentAmount(currency));

  const amountCents = requireMinor(amount);

  let result: Awaited<ReturnType<typeof recordDebtPayment>>;
  try {
    result = await recordDebtPayment({
      fromAccountId,
      toAccountId,
      amountCents,
      occurredAt,
      requestRef,
    });
  } catch (error) {
    mapPaymentError(error);
  }

  return { transactionId: result.transactionId };
}
