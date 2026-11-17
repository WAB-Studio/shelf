import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { withdrawToCash } from "@/db/queries/cash-write";
import { recordCardStatement } from "@/db/queries/card-statement-write";
import { getMovementDeferral } from "@/db/queries/deferrals";
import { deferPurchase, recordBilled, recordStatement, undeferPurchase } from "@/db/queries/statement-write";
import { getSettlementCurrencies } from "@/db/queries/transactions";
import { BASE_CURRENCY } from "@/lib/currency";
import { ActionError } from "@/lib/errors";
import { PERSONAL_CASH_ACCOUNT_NAME } from "@/lib/fund/seed";
import { ADD, ADD_ONCE, DESTROY, OVERWRITE, titled } from "@/lib/mcp/annotations";
import { parseForm } from "@/lib/mcp/parse-form";
import { centsToDecimal } from "@/lib/money";
import { recordAccountStatementSchema } from "@/lib/validation/account-statement";
import { withdrawCashSchema } from "@/lib/validation/cash";
import { recordBilledAmountSchema } from "@/lib/validation/debt-settlement";
import { cardStatementExtrasSchema } from "@/lib/validation/card-statement";
import { DEBT_KINDS } from "@/lib/validation/debt-terms";
import { deferPurchaseSchema, undeferPurchaseSchema } from "@/lib/validation/deferral";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

// RF-259 rides along: `record_card_statement` stores what Claude read off a card's statement PDF.
// RF-234: the debt screen's statement, billed-amount and deferral controls and the cash withdrawal, through their own
// schemas and write functions. The debt is an account `list_debts` answers; what a statement or a deferral left
// reads back in `get_debt`.
export function registerDebtStatementTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);
  const text = (cents: number | null | undefined) => (cents == null ? null : centsToDecimal(cents));
  const optionalCents = (key: string) => z.number().int().nullish().describe(d(key));

  server.registerTool(
    "record_account_statement",
    {
      ...titled(t, "recordAccountStatement"),
      description: t("tools.recordAccountStatement"),
      inputSchema: z.object({
        accountId: z.string().describe(d("debtAccountId")),
        periodStart: z.string().describe(d("statementPeriodStart")),
        cutOffDate: z.string().describe(d("statementCutOffDate")),
        paymentDueDate: z.string().nullish().describe(d("statementPaymentDueDate")),
        closingBalanceCents: z.number().int().describe(d("statementClosingBalanceCents")),
        openingBalanceCents: optionalCents("statementOpeningBalanceCents"),
        creditsCents: optionalCents("statementCreditsCents"),
        debitsCents: optionalCents("statementDebitsCents"),
        minimumPaymentCents: optionalCents("statementMinimumPaymentCents"),
        interestChargedCents: optionalCents("statementInterestChargedCents"),
        feesChargedCents: optionalCents("statementFeesChargedCents"),
      }),
      annotations: ADD,
    },
    (input, ctx) =>
      run(ctx, async () => {
        const accountId = parseForm(z.uuid({ error: "installments.errors.accountInvalid" }), input.accountId);
        // The schema wants the currency the form was handed; the write reads the account's own again.
        const settlement = await getSettlementCurrencies({ fromAccountId: accountId, toAccountId: null });
        await recordStatement(
          parseForm(recordAccountStatementSchema, {
            accountId,
            currency: settlement.from ?? BASE_CURRENCY,
            periodStart: input.periodStart,
            cutOffDate: input.cutOffDate,
            paymentDueDate: input.paymentDueDate ?? null,
            openingBalance: text(input.openingBalanceCents),
            closingBalance: centsToDecimal(input.closingBalanceCents),
            credits: text(input.creditsCents),
            debits: text(input.debitsCents),
            minimumPayment: text(input.minimumPaymentCents),
            interestCharged: text(input.interestChargedCents),
            feesCharged: text(input.feesChargedCents),
          }),
        );
        return { accountId, cutOffDate: input.cutOffDate };
      }),
  );

  // RF-259: one call for a statement PDF. `dryRun` plans and writes nothing; the real call writes the same plan.
  server.registerTool(
    "record_card_statement",
    {
      ...titled(t, "recordCardStatement"),
      description: t("tools.recordCardStatement"),
      inputSchema: z.object({
        accountId: z.string().describe(d("debtAccountId")),
        dryRun: z.boolean().optional().describe(d("cardDryRun")),
        statement: z
          .object({
            periodStart: z.string().describe(d("statementPeriodStart")),
            cutOffDate: z.string().describe(d("statementCutOffDate")),
            paymentDueDate: z.string().nullish().describe(d("statementPaymentDueDate")),
            closingBalanceCents: z.number().int().describe(d("statementClosingBalanceCents")),
            openingBalanceCents: optionalCents("statementOpeningBalanceCents"),
            creditsCents: optionalCents("statementCreditsCents"),
            debitsCents: optionalCents("statementDebitsCents"),
            minimumPaymentCents: optionalCents("statementMinimumPaymentCents"),
            interestChargedCents: optionalCents("statementInterestChargedCents"),
            feesChargedCents: optionalCents("statementFeesChargedCents"),
          })
          .describe(d("cardStatement")),
        terms: z
          .object({
            debtKind: z.enum(DEBT_KINDS).optional().describe(d("debtKind")),
            annualRatePct: z.string().nullish().describe(d("annualRatePct")),
            creditLimitCents: optionalCents("creditLimitCents"),
            statementCutOffDay: z.number().int().nullish().describe(d("statementCutOffDay")),
            paymentDueDay: z.number().int().nullish().describe(d("paymentDueDay")),
            minimumPaymentCents: optionalCents("minimumPaymentCents"),
            minimumPaymentPct: z.string().nullish().describe(d("minimumPaymentPct")),
            avalCents: optionalCents("avalCents"),
          })
          .optional()
          .describe(d("cardTerms")),
        deferrals: z
          .array(
            z.object({
              authorizationNumber: z.string().describe(d("cardAuthorizationNumber")),
              description: z.string().describe(d("cardDeferralDescription")),
              currency: z.string().describe(d("cardSectionCurrency")),
              originalAmountCents: z.number().int().describe(d("cardOriginalAmountCents")),
              instalments: z.number().int().describe(d("cardInstalments")),
              currentInstalment: z.number().int().describe(d("cardCurrentInstalment")),
              monthlyInstalmentCents: z.number().int().describe(d("cardMonthlyInstalmentCents")),
              pendingBalanceCents: z.number().int().describe(d("cardPendingBalanceCents")),
              annualRatePct: z.string().describe(d("cardDeferralRatePct")),
            }),
          )
          .optional()
          .describe(d("cardDeferrals")),
        purchases: z
          .array(
            z.object({
              occurredOn: z.string().describe(d("occurredOn")),
              amountCents: z.number().int().describe(d("cardPurchaseAmountCents")),
              currency: z.string().describe(d("cardSectionCurrency")),
              description: z.string().nullish().describe(d("cardPurchaseDescription")),
            }),
          )
          .optional()
          .describe(d("cardPurchases")),
      }),
      annotations: OVERWRITE,
    },
    (input, ctx) =>
      run(ctx, async () => {
        const accountId = parseForm(z.uuid({ error: "installments.errors.accountInvalid" }), input.accountId);
        const settlement = await getSettlementCurrencies({ fromAccountId: accountId, toAccountId: null });
        const statement = parseForm(recordAccountStatementSchema, {
          accountId,
          currency: settlement.from ?? BASE_CURRENCY,
          periodStart: input.statement.periodStart,
          cutOffDate: input.statement.cutOffDate,
          paymentDueDate: input.statement.paymentDueDate ?? null,
          openingBalance: text(input.statement.openingBalanceCents),
          closingBalance: centsToDecimal(input.statement.closingBalanceCents),
          credits: text(input.statement.creditsCents),
          debits: text(input.statement.debitsCents),
          minimumPayment: text(input.statement.minimumPaymentCents),
          interestCharged: text(input.statement.interestChargedCents),
          feesCharged: text(input.statement.feesChargedCents),
        });
        const extras = parseForm(cardStatementExtrasSchema, {
          deferrals: input.deferrals ?? [],
          purchases: input.purchases ?? [],
        });
        return recordCardStatement({
          accountId,
          dryRun: input.dryRun ?? false,
          statement,
          terms: input.terms ?? {},
          ...extras,
        });
      }),
  );

  server.registerTool(
    "record_billed_amount",
    {
      ...titled(t, "recordBilledAmount"),
      description: t("tools.recordBilledAmount"),
      inputSchema: z.object({
        transactionId: z.string().describe(d("transactionId")),
        accountId: z.string().describe(d("debtAccountId")),
        currency: z.string().describe(d("billedCurrency")),
        billedCents: z.number().int().describe(d("billedCents")),
      }),
      annotations: OVERWRITE,
    },
    (input, ctx) =>
      run(ctx, async () => {
        await recordBilled(
          parseForm(recordBilledAmountSchema, {
            transactionId: input.transactionId,
            accountId: input.accountId,
            currency: input.currency,
            billedAmount: centsToDecimal(input.billedCents),
          }),
        );
        return { transactionId: input.transactionId };
      }),
  );

  server.registerTool(
    "defer_purchase",
    {
      ...titled(t, "deferPurchase"),
      description: t("tools.deferPurchase"),
      inputSchema: z.object({
        transactionId: z.string().describe(d("transactionId")),
        instalments: z.number().int().describe(d("deferInstalments")),
      }),
      annotations: OVERWRITE,
    },
    (input, ctx) =>
      run(ctx, async () => {
        const parsed = parseForm(deferPurchaseSchema, input);
        await deferPurchase(parsed);
        return { transactionId: parsed.transactionId, instalments: parsed.instalments };
      }),
  );

  server.registerTool(
    "undefer_purchase",
    {
      ...titled(t, "undeferPurchase"),
      description: t("tools.undeferPurchase"),
      inputSchema: z.object({ transactionId: z.string().describe(d("transactionId")) }),
      annotations: DESTROY,
    },
    (input: { transactionId: string }, ctx) =>
      run(ctx, async () => {
        const { transactionId } = parseForm(undeferPurchaseSchema, input);
        const { deferral } = await getMovementDeferral(transactionId);
        await undeferPurchase({ transactionId });
        return { transactionId, before: { instalments: deferral?.instalments ?? null } };
      }),
  );

  // «Sacar efectivo»: one transfer from an asset into the caller's cash, created on demand and named in Spanish.
  server.registerTool(
    "withdraw_cash",
    {
      ...titled(t, "withdrawCash"),
      description: t("tools.withdrawCash"),
      inputSchema: z.object({
        sourceAccountId: z.string().describe(d("withdrawSourceAccountId")),
        amountCents: z.number().int().describe(d("amountCents")),
        requestRef: z.uuid().describe(d("requestRef")),
      }),
      annotations: ADD_ONCE,
    },
    (input, ctx) =>
      run(ctx, async () => {
        const result = await withdrawToCash(
          parseForm(withdrawCashSchema, {
            sourceAccountId: input.sourceAccountId,
            amount: centsToDecimal(input.amountCents),
            requestRef: input.requestRef,
          }),
          PERSONAL_CASH_ACCOUNT_NAME.es,
        );
        if (!result) throw new ActionError("errors.unexpected");
        return result;
      }),
  );
}
