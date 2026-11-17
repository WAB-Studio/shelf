import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { getDebtDetail } from "@/db/queries/debt-detail";
import { payDebt, saveDebtTerms } from "@/db/queries/debt-write";
import { getDebtsScreenData } from "@/db/queries/debts-screen";
import { ActionError } from "@/lib/errors";
import { ADD_ONCE, READ, titled } from "@/lib/mcp/annotations";
import { parseForm } from "@/lib/mcp/parse-form";
import { todayInBogota } from "@/lib/dates";
import { centsToDecimal } from "@/lib/money";
import { DEBT_KINDS, debtTermsSchema } from "@/lib/validation/debt-terms";
import { recordDebtPaymentSchema } from "@/lib/validation/installment-plan";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

// RF-227: the Deudas screen read whole, a debt's detail, its terms and «Abonar», through the screen's own queries,
// schemas and write functions. The debt is an account `list_accounts` answers with kind liability.
export function registerDebtTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);
  const cents = (value: number | null | undefined) => (value == null ? null : centsToDecimal(value));

  server.registerTool(
    "list_debts",
    { ...titled(t, "listDebts"), description: t("tools.listDebts"), inputSchema: z.object({}), annotations: READ },
    (_input, ctx) => run(ctx, () => getDebtsScreenData()),
  );

  server.registerTool(
    "get_debt",
    {
      ...titled(t, "getDebt"),
      description: t("tools.getDebt"),
      inputSchema: z.object({ accountId: z.string().describe(d("debtAccountId")) }),
      annotations: READ,
    },
    (input: { accountId: string }, ctx) =>
      run(ctx, async () => {
        const detail = await getDebtDetail(parseForm(z.uuid({ error: "errors.notFound" }), input.accountId));
        if (detail === null) throw new ActionError("errors.notFound");
        return detail;
      }),
  );

  // The form's schema and `saveDebtTerms`: terms land on a debt with none, and the same values again change nothing.
  server.registerTool(
    "set_debt_terms",
    {
      ...titled(t, "setDebtTerms"),
      description: t("tools.setDebtTerms"),
      inputSchema: z.object({
        accountId: z.string().describe(d("debtAccountId")),
        debtKind: z.enum(DEBT_KINDS).describe(d("debtKind")),
        annualRatePct: z.string().describe(d("annualRatePct")),
        minimumPaymentCents: z.number().int().nullish().describe(d("minimumPaymentCents")),
        minimumPaymentPct: z.string().nullish().describe(d("minimumPaymentPct")),
        creditLimitCents: z.number().int().nullish().describe(d("creditLimitCents")),
        statementCutOffDay: z.number().int().nullish().describe(d("statementCutOffDay")),
        paymentDueDay: z.number().int().nullish().describe(d("paymentDueDay")),
        avalCents: z.number().int().nullish().describe(d("avalCents")),
      }),
      annotations: ADD_ONCE,
    },
    (input, ctx) =>
      run(ctx, () =>
        saveDebtTerms(
          parseForm(debtTermsSchema, {
            accountId: input.accountId,
            debtKind: input.debtKind,
            annualRate: input.annualRatePct,
            minimumPayment: cents(input.minimumPaymentCents),
            minimumPaymentPct: input.minimumPaymentPct,
            creditLimit: cents(input.creditLimitCents),
            statementCutOffDay: input.statementCutOffDay,
            paymentDueDay: input.paymentDueDay,
            aval: cents(input.avalCents),
          }),
        ),
      ),
  );

  // «Abonar»: one transfer from an asset into the debt, booked once per `requestRef`.
  server.registerTool(
    "record_debt_payment",
    {
      ...titled(t, "recordDebtPayment"),
      description: t("tools.recordDebtPayment"),
      inputSchema: z.object({
        fromAccountId: z.string().describe(d("debtFromAccountId")),
        toAccountId: z.string().describe(d("debtAccountId")),
        amountCents: z.number().int().describe(d("amountCents")),
        occurredOn: z.string().optional().describe(d("occurredOnDefault")),
        requestRef: z.uuid().describe(d("requestRef")),
      }),
      annotations: ADD_ONCE,
    },
    (input, ctx) =>
      run(ctx, () =>
        payDebt(
          parseForm(recordDebtPaymentSchema, {
            fromAccountId: input.fromAccountId,
            toAccountId: input.toAccountId,
            amount: centsToDecimal(input.amountCents),
            occurredAt: input.occurredOn ?? todayInBogota(),
            requestRef: input.requestRef,
          }),
        ),
      ),
  );
}
