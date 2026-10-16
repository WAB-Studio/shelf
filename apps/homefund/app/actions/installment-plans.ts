"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import {
  createInstallmentPlan,
  deleteInstallmentPlan,
  recordDebtPayment,
} from "@/db/queries/installment-plans";
import { getSettlementCurrencies } from "@/db/queries/transactions";
import { BASE_CURRENCY } from "@/lib/currency";
import { addCivilDays, addCivilMonths } from "@/lib/dates";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { parseAmount } from "@/lib/money";
import { authActionClient } from "@/lib/safe-action";
import { percentToFraction } from "@/lib/validation/debt-terms";
import {
  createInstallmentPlanSchema,
  deleteInstallmentPlanSchema,
  recordDebtPaymentSchema,
  refineDebtPaymentAmount,
  refineInstallmentPlanAmounts,
} from "@/lib/validation/installment-plan";

// An amount arrives as a Zod-validated string; turning it into the integer the
// column keeps can only fail if the refinement above let something through it
// should not have.
function toMinor(amount: string): number {
  const minor = parseAmount(amount);
  if (minor === null) throw new ActionError("errors.unexpected");
  return minor;
}

// The refinement the form runs, run again here against the currency read off the
// account rather than the one the payload claims (RNF-10). The first issue is
// what the caller is told, as every other refusal in this file reports one.
function assertAmounts<T>(
  data: T,
  refine: (data: T, ctx: z.RefinementCtx) => void,
): void {
  const verdict = z.custom<T>().superRefine(refine).safeParse(data);
  if (!verdict.success) throw new ActionError(verdict.error.issues[0].message);
}

// Line `i` (1..n) falls `(i - 1)` steps after the start, a step being a whole
// month (monthly, clamped to month-end so a 31 never rolls past a short month)
// or 14 days (fortnightly) (RF-81).
function scheduleDates(
  startDate: string,
  frequency: "monthly" | "fortnightly",
  count: number,
): string[] {
  return Array.from({ length: count }, (_, index) =>
    frequency === "monthly"
      ? addCivilMonths(startDate, index)
      : addCivilDays(startDate, index * 14),
  );
}

// Splits a cent total evenly into `count` lines, the remainder cents landing one
// each on the earliest lines so the lines sum EXACTLY to the total — no float.
function splitCents(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_, index) =>
    index < remainder ? base + 1 : base,
  );
}

// The `assert_installment_plan_account` trigger raises 23514 when the account is
// not a liability; a denied write reads as an absent plan, and a deleted account
// with it — the policy is the account's and runs ahead of any foreign key. 23503
// is the net under that: a reference gone after it was picked. Scope comes from
// the account through RLS, never a payload.
function mapPlanError(error: unknown): never {
  const code = pgErrorCode(error);
  if (code === "42501") throw new ActionError("errors.notFound");
  if (code === "23514") throw new ActionError("installments.errors.notLiability");
  if (code === "23503") throw new ActionError("errors.referenceGone");
  throw error;
}

// The query's own kinds guard, both halves of it, raised before anything is written.
const ASSET_SOURCE_REFUSAL = "comes from an asset account";
const LIABILITY_TARGET_REFUSAL = "credits a liability account";

// The driver hangs its message off the cause chain the way it hangs its sqlstate:
// the error thrown only says which query failed.
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

// Four refusals share 23514: the two halves of the kinds guard above,
// `assert_installment_line_payment` when the settling movement does not touch the
// plan account, and `assert_installment_allocation` when the allocation is not
// oldest-first and in full. The message is what tells them apart — on the code
// alone every one of them would answer with the same key. A payment aimed at an
// account that is no debt names what `mapPlanError` names for a plan aimed at
// one: the mistake is the same. What is left over is the two triggers. A movement
// into another member's account — or into one just deleted — is denied by RLS
// (42501) and reads as absent. 23503 is the net under that: a reference gone
// after it was picked.
function mapPaymentError(error: unknown): never {
  const code = pgErrorCode(error);
  if (code === "42501") throw new ActionError("errors.notFound");
  // A source and a debt that settle in different currencies: the movement would
  // carry a rate, and this path names no second amount for it (migration `0032`).
  if (code === "23901") throw new ActionError("transactions.errors.currencyMismatch");
  if (code === "23514") {
    if (refusalMentions(error, ASSET_SOURCE_REFUSAL)) {
      throw new ActionError("installments.errors.notFromAsset");
    }
    if (refusalMentions(error, LIABILITY_TARGET_REFUSAL)) {
      throw new ActionError("installments.errors.notLiability");
    }
    throw new ActionError("installments.errors.paymentInvalid");
  }
  if (code === "23503") throw new ActionError("errors.referenceGone");
  throw error;
}

/**
 * Schedules an existing liability balance into dated lines (RF-81). The aval is
 * folded into the principal and the sum split evenly across the installments, the
 * remainder cents on the earliest lines, so the lines total `principal + aval`
 * exactly; the down payment is stored as given and never subtracted. The scope
 * comes from the account through RLS, so no owner or group travels here.
 *
 * Every amount is read in the currency the debt settles in, read off the account
 * and never off the payload (RF-121): a plan schedules the balance that account
 * carries, so it is denominated in the currency that balance is.
 */
export const createInstallmentPlanAction = authActionClient
  .inputSchema(createInstallmentPlanSchema)
  .action(
    async ({
      parsedInput: {
        accountId,
        description,
        principal,
        nInstallments,
        frequency,
        interestRate,
        downPayment,
        aval,
        startDate,
        merchant,
      },
    }) => {
      const settlement = await getSettlementCurrencies({
        fromAccountId: accountId,
        toAccountId: null,
      });
      const currency = settlement.from ?? BASE_CURRENCY;

      assertAmounts(
        { principal, downPayment, aval },
        refineInstallmentPlanAmounts(currency),
      );

      const principalCents = toMinor(principal);
      const avalCents = aval != null ? toMinor(aval) : null;
      const scheduledTotal = principalCents + (avalCents ?? 0);

      const dueDates = scheduleDates(startDate, frequency, nInstallments);
      const amounts = splitCents(scheduledTotal, nInstallments);
      const lines = dueDates.map((dueDate, index) => ({
        seq: index + 1,
        dueDate,
        amountCents: amounts[index],
      }));

      let planId: string;
      try {
        ({ planId } = await createInstallmentPlan({
          accountId,
          description: description ?? null,
          principalCents,
          nInstallments,
          frequency,
          interestRate: interestRate != null ? percentToFraction(interestRate) : null,
          downPaymentCents: downPayment != null ? toMinor(downPayment) : null,
          avalCents,
          startDate,
          merchant: merchant ?? null,
          lines,
        }));
      } catch (error) {
        mapPlanError(error);
      }

      refresh();
      return { planId };
    },
  );

/**
 * Records a payment that credits a liability from an asset and allocates it
 * oldest-first onto the debt's unpaid lines (RF-16, RF-82). The transfer's scope
 * and kind fall to triggers; deleting the movement later unwinds the allocation
 * on its own, so there is no explicit unlink path. The lines it closed and the
 * remainder it left over travel back, so the caller can name both.
 *
 * The amount is read in the currency the SOURCE settles in, which is the one
 * `set_transaction_currency` books the movement in (RF-121). A source and a debt
 * that settle in different currencies make a movement that carries a rate, which
 * this path names no second amount for: `transactions_verify_currency` refuses
 * it, and the refusal maps below.
 */
export const recordDebtPaymentAction = authActionClient
  .inputSchema(recordDebtPaymentSchema)
  .action(async ({ parsedInput: { fromAccountId, toAccountId, amount, occurredAt } }) => {
    const settlement = await getSettlementCurrencies({ fromAccountId, toAccountId });
    const currency = settlement.from ?? BASE_CURRENCY;

    assertAmounts({ amount }, refineDebtPaymentAmount(currency));

    const amountCents = toMinor(amount);

    let result: {
      transactionId: string;
      paidLineIds: string[];
      remainderCents: number;
    };
    try {
      result = await recordDebtPayment({
        fromAccountId,
        toAccountId,
        amountCents,
        occurredAt,
      });
    } catch (error) {
      mapPaymentError(error);
    }

    refresh();
    return {
      transactionId: result.transactionId,
      paidLineIds: result.paidLineIds,
      remainderCents: result.remainderCents,
    };
  });

// A denied or absent plan reports as no row (RF-81).
export const deleteInstallmentPlanAction = authActionClient
  .inputSchema(deleteInstallmentPlanSchema)
  .action(async ({ parsedInput: { planId } }) => {
    const deleted = await deleteInstallmentPlan({ planId });
    if (!deleted) throw new ActionError("errors.notFound");

    refresh();
  });
