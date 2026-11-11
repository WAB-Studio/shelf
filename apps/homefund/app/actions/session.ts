"use server";

import { refresh } from "next/cache";

import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { keepDaysOf, keepSignedInSchema } from "@/lib/validation/session";
import { KEEP_SIGNED_IN_KEY } from "@/lib/auth/inactivity";

/**
 * Sets how long a device may sit unused before HomeFund signs it out (RF-190). The limit lives in
 * the person's auth metadata, so the proxy reads it from the claims it already verifies and every
 * device meets it without a query. The refresh that follows is what puts the new value into this
 * device's token at once; the others pick it up at their next refresh.
 */
export const setKeepSignedInAction = authActionClient.inputSchema(keepSignedInSchema).action(async ({ parsedInput: { days } }) => {
  const supabase = await createSupabaseServerClient();

  // `null` deletes the key: the default, «Siempre».
  const updated = await supabase.auth.updateUser({ data: { [KEEP_SIGNED_IN_KEY]: keepDaysOf(days) } });
  if (updated.error) throw new ActionError("errors.unexpected");

  const refreshed = await supabase.auth.refreshSession();
  if (refreshed.error) throw new ActionError("errors.unexpected");

  refresh();
});
