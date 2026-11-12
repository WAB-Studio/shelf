import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { createTranslator } from "next-intl";
import { z } from "zod";

import { listThirdPartyCredits, recordThirdPartyPayment } from "@/db/queries/third-party-credits";
import { parseForm } from "@/lib/mcp/parse-form";
import { centsToDecimal } from "@/lib/money";
import { recordThirdPartyPaymentSchema } from "@/lib/validation/third-party-credit";

import es from "../../messages/es.json";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

// The movement's description, in the words the person's screen writes it with.
const tForm = createTranslator({ locale: "es", messages: { thirdPartyCredit: es.thirdPartyCredit }, namespace: "thirdPartyCredit" });

// RF-214: a credit somebody else pays, read and its payer's money recorded through the same query and schema as
// the credit's screen. The credit and the accounts are the ids `list_third_party_credits` and `list_accounts` answer.
export function registerThirdPartyCreditTools(server: McpServer, run: Run, t: Say): void {
  const d = (key: string) => t(`params.${key}`);

  server.registerTool(
    "list_third_party_credits",
    { description: t("tools.listThirdPartyCredits"), inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    (_input, ctx) => run(ctx, () => listThirdPartyCredits()),
  );

  server.registerTool(
    "record_third_party_payment",
    {
      description: t("tools.recordThirdPartyPayment"),
      inputSchema: z.object({
        liabilityAccountId: z.string().describe(d("creditLiabilityAccountId")),
        toAccountId: z.string().describe(d("creditToAccountId")),
        amountCents: z.number().int().describe(d("amountCents")),
        occurredOn: z.string().describe(d("occurredOn")),
        requestRef: z.string().optional().describe(d("requestRef")),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    (input, ctx) =>
      run(ctx, () =>
        recordThirdPartyPayment(
          parseForm(recordThirdPartyPaymentSchema, {
            liabilityAccountId: input.liabilityAccountId,
            toAccountId: input.toAccountId,
            amount: centsToDecimal(input.amountCents),
            occurredAt: input.occurredOn,
            requestRef: input.requestRef,
          }),
          (person) => tForm("paymentDescription", { person }),
        ),
      ),
  );
}
