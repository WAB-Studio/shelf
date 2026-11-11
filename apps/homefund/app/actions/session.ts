"use server";

import { refresh } from "next/cache";

import { KEEP_SIGNED_IN_KEY } from "@/lib/auth/inactivity";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { keepDaysOf, keepSignedInSchema } from "@/lib/validation/session";

/**
 * Sets how long a device may sit unused before HomeFund signs it out (RF-190). The limit lives in
 * the person's auth metadata. Only the proxy refreshes a token, so every device, this one too,
 * meets the new limit at its next refresh, within the hour; Ajustes reads the stored value itself.
 */
export const setKeepSignedInAction = authActionClient.inputSchema(keepSignedInSchema).action(async ({ parsedInput: { days } }) => {
  const supabase = await createSupabaseServerClient();

  // `null` deletes the key: the default, «Siempre».
  const updated = await supabase.auth.updateUser({ data: { [KEEP_SIGNED_IN_KEY]: keepDaysOf(days) } });
  if (updated.error) throw new ActionError("errors.unexpected");

  refresh();
});
