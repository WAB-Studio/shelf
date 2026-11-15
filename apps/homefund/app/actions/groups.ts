"use server";

import { getLocale } from "next-intl/server";
import { refresh } from "next/cache";

import { updateFund } from "@/db/queries/member-write";
import { authActionClient } from "@/lib/safe-action";
import { updateGroupSchema } from "@/lib/validation/group";

/** The group comes from the session, never from the form (RF-55); the locale names the cash account a switch to 'shared' may create. */
export const updateGroupAction = authActionClient
  .inputSchema(updateGroupSchema)
  .action(async ({ parsedInput }) => {
    await updateFund(parsedInput, await getLocale());

    refresh();
  });
