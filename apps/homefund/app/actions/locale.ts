"use server";

import { cookies } from "next/headers";

import { upsertUserLocale } from "@/db/queries/user-locale";
import { getSessionUser } from "@/db/session";
import { actionClient } from "@/lib/safe-action";
import { setLocaleSchema } from "@/lib/validation/locale";

const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Persists the language (RF-46, RF-47). Deliberately not on `authActionClient`:
 * a signed-out visitor on the login screen switches language too, and for them
 * the cookie is the whole preference.
 */
export const setLocaleAction = actionClient
  .inputSchema(setLocaleSchema)
  .action(async ({ parsedInput: { locale } }) => {
    const cookieStore = await cookies();
    // The name next-intl reads when the URL carries no locale.
    cookieStore.set("NEXT_LOCALE", locale, {
      path: "/",
      maxAge: LOCALE_COOKIE_MAX_AGE,
      sameSite: "lax",
    });

    if (await getSessionUser()) await upsertUserLocale(locale);

    return { locale };
  });
