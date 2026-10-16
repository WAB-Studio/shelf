"use server";

import { getLocale } from "next-intl/server";
import { refresh } from "next/cache";

import { getUserGroup, updateGroupSettings } from "@/db/queries/groups";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import { updateGroupSchema } from "@/lib/validation/group";

/**
 * Renames the caller's group, sets where its cash sits and what it reports in
 * (RF-56, RF-57, RF-121). The group comes from the session, never from the
 * form (RF-55). The locale comes from the request: it names the cash account
 * a switch to 'shared' may create. The leader alone gets a row back, so
 * `false` reads as the refusal it is.
 */
export const updateGroupAction = authActionClient
  .inputSchema(updateGroupSchema)
  .action(async ({ parsedInput: { name, cashMode, currency } }) => {
    const group = await getUserGroup();
    if (!group) throw new ActionError("errors.notFound");

    const locale = await getLocale();
    const updated = await updateGroupSettings({
      groupId: group.id,
      name,
      cashMode,
      currency,
      locale,
    });

    if (!updated) throw new ActionError("errors.notLeader");

    refresh();
  });
