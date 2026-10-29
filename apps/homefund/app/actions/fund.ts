"use server";

import { getLocale } from "next-intl/server";

import { createGroup } from "@/db/queries/create-group";
import { redirect } from "@/i18n/navigation";
import { authActionClient } from "@/lib/safe-action";
import { createFundSchema } from "@/lib/validation/fund";

/**
 * Creates a group and makes the caller its leader (RF-59). The locale comes from
 * the request, never from the form: it decides the language the seed categories
 * and the group's cash account land in. `cash_mode` defaults to a single shared
 * pot (RF-56); a screen to choose it is not part of this slice. The currency the
 * fund settles in comes from the form (RF-121) and the seeded cash account
 * inherits it.
 */
export const createGroupAction = authActionClient
  .inputSchema(createFundSchema)
  .action(async ({ parsedInput: { name, memberName, currency } }) => {
    const locale = await getLocale();
    await createGroup({
      name,
      leaderName: memberName,
      cashMode: "shared",
      currency,
      locale,
    });

    redirect({ href: "/onboarding/accounts", locale });
  });
