"use server";

import { upsertUserLocale } from "@/db/queries/user-locale";
import { getSessionUser } from "@/db/session";
import { actionClient } from "@/lib/safe-action";
import { setLocaleSchema } from "@/lib/validation/locale";

/**
 * Saves the language on the person's row (RF-46, RF-47); the switcher then opens the page in it. Deliberately not
 * on `authActionClient`: a signed-out visitor on the login screen switches language too, and for them it only
 * answers with the language, since the URL is what decides it (RF-218).
 */
export const setLocaleAction = actionClient
  .inputSchema(setLocaleSchema)
  .action(async ({ parsedInput: { locale } }) => {
    if (await getSessionUser()) await upsertUserLocale(locale);

    return { locale };
  });
