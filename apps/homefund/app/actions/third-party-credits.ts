"use server";

import { refresh } from "next/cache";
import { getTranslations } from "next-intl/server";

import {
  recordThirdPartyPayment,
  removeThirdPartyCredit,
  setUpThirdPartyCredit,
  updateThirdPartyCredit,
} from "@/db/queries/third-party-credits";
import { authActionClient } from "@/lib/safe-action";
import {
  recordThirdPartyPaymentSchema,
  removeThirdPartyCreditSchema,
  setUpThirdPartyCreditSchema,
  updateThirdPartyCreditSchema,
} from "@/lib/validation/third-party-credit";

// RF-211: a credit somebody else pays. The account a new «Me debe» opens under is named in the person's language.
export const setUpThirdPartyCreditAction = authActionClient
  .inputSchema(setUpThirdPartyCreditSchema)
  .action(async ({ parsedInput }) => {
    const t = await getTranslations("thirdPartyCredit");
    const created = await setUpThirdPartyCredit(parsedInput, t("receivableName", { person: parsedInput.personName }));
    refresh();
    return created;
  });

export const updateThirdPartyCreditAction = authActionClient
  .inputSchema(updateThirdPartyCreditSchema)
  .action(async ({ parsedInput }) => {
    await updateThirdPartyCredit(parsedInput);
    refresh();
  });

export const removeThirdPartyCreditAction = authActionClient
  .inputSchema(removeThirdPartyCreditSchema)
  .action(async ({ parsedInput: { liabilityAccountId } }) => {
    await removeThirdPartyCredit(liabilityAccountId);
    refresh();
  });

// RF-213: «Registrar pago de <persona>», the transfer from the receivable to the bank account it arrived in.
export const recordThirdPartyPaymentAction = authActionClient
  .inputSchema(recordThirdPartyPaymentSchema)
  .action(async ({ parsedInput }) => {
    const t = await getTranslations("thirdPartyCredit");
    const created = await recordThirdPartyPayment(parsedInput, (person) => t("paymentDescription", { person }));
    refresh();
    return created;
  });
