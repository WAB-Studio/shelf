import "server-only";

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { createTranslator } from "next-intl";
import { z } from "zod";

import {
  listThirdPartyCredits,
  readCreditOwedCents,
  recordThirdPartyPayment,
  setUpThirdPartyCredit,
  updateThirdPartyCredit,
} from "@/db/queries/third-party-credits";
import { todayInBogota } from "@/lib/dates";
import { ActionError } from "@/lib/errors";
import { parseForm } from "@/lib/mcp/parse-form";
import { centsToDecimal } from "@/lib/money";
import {
  recordThirdPartyPaymentSchema,
  setUpThirdPartyCreditSchema,
  updateThirdPartyCreditSchema,
} from "@/lib/validation/third-party-credit";

import es from "../../messages/es.json";

type Run = (ctx: ServerContext, load: (owner: string) => Promise<unknown>) => Promise<CallToolResult>;
type Say = (key: string) => string;

// The movement's description, in the words the person's screen writes it with.
const tForm = createTranslator({ locale: "es", messages: { thirdPartyCredit: es.thirdPartyCredit }, namespace: "thirdPartyCredit" });

// RF-214: a credit somebody else pays, linked, read and its payer's money recorded through the same query and schema as
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

  const lenderTerms = {
    installmentCents: z.number().int().nullish().describe(d("creditInstallmentCents")),
    dueDay: z.number().int().nullish().describe(d("creditDueDay")),
  };
  const text = (value: number | null | undefined) => (value == null ? "" : centsToDecimal(value));

  // The dialog's own schema and write: a new «Me debe» opens at what is left of the credit unless an amount is sent.
  server.registerTool(
    "link_third_party_credit",
    {
      description: t("tools.linkThirdPartyCredit"),
      inputSchema: z.object({
        liabilityAccountId: z.string().describe(d("creditLiabilityAccountId")),
        personName: z.string().describe(d("creditPersonName")),
        receivableAccountId: z.string().nullish().describe(d("creditReceivableAccountId")),
        openingCents: z.number().int().nullish().describe(d("creditOpeningCents")),
        openedOn: z.string().optional().describe(d("creditOpenedOn")),
        ...lenderTerms,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (input, ctx) =>
      run(ctx, async () => {
        const credit = parseForm(z.uuid({ error: "errors.notFound" }), input.liabilityAccountId);
        const owed = input.receivableAccountId ? 0 : (input.openingCents ?? (await readCreditOwedCents(credit)));
        if (owed === null) throw new ActionError("errors.notFound");
        const linked = await setUpThirdPartyCredit(
          parseForm(setUpThirdPartyCreditSchema, {
            liabilityAccountId: input.liabilityAccountId,
            personName: input.personName,
            receivableAccountId: input.receivableAccountId ?? "",
            amount: centsToDecimal(owed),
            openedOn: input.openedOn ?? todayInBogota(),
            installmentAmount: text(input.installmentCents),
            dueDay: input.dueDay == null ? "" : String(input.dueDay),
          }),
          tForm("receivableName", { person: input.personName.trim() }),
        );
        return { id: linked.id, liabilityAccountId: input.liabilityAccountId, receivableAccountId: linked.receivableAccountId };
      }),
  );

  // What the call omits stays as the link has it; null clears the installment or the due day.
  server.registerTool(
    "update_third_party_credit",
    {
      description: t("tools.updateThirdPartyCredit"),
      inputSchema: z.object({
        liabilityAccountId: z.string().describe(d("creditLiabilityAccountId")),
        personName: z.string().optional().describe(d("creditPersonName")),
        ...lenderTerms,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    (input, ctx) =>
      run(ctx, async () => {
        const [current] = await listThirdPartyCredits(parseForm(z.uuid({ error: "errors.notFound" }), input.liabilityAccountId));
        if (!current) throw new ActionError("errors.notFound");
        const installmentCents = input.installmentCents === undefined ? current.installmentCents : input.installmentCents;
        const dueDay = input.dueDay === undefined ? current.dueDay : input.dueDay;
        await updateThirdPartyCredit(
          parseForm(updateThirdPartyCreditSchema, {
            liabilityAccountId: input.liabilityAccountId,
            personName: input.personName ?? current.personName,
            installmentAmount: text(installmentCents),
            dueDay: dueDay == null ? "" : String(dueDay),
          }),
        );
        return { liabilityAccountId: input.liabilityAccountId };
      }),
  );
}
