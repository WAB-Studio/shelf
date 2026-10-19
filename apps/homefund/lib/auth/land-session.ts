import "server-only";

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";

import { insertRow } from "@/db/insert-row";
import { seedPersonalCategories } from "@/db/queries/personal-space";
import { appUsers } from "@/db/schema";
import { withUserDb } from "@/db/session";
import { isInternalPath } from "@/lib/internal-path";
import type { Locale } from "@/lib/locales";

/**
 * Lands a verified session (RF-01, RF-146): the same for the link and the
 * code. Writes the `app_users` row, seeds on the first sign-in, and returns where the person goes next.
 */
export async function landSession({
  user,
  fallbackLocale,
}: {
  user: { id: string; email?: string | null };
  fallbackLocale: Locale;
}): Promise<{ target: string; locale: Locale }> {
  const userId = user.id;

  const locale = await withUserDb(async (tx) => {
    // One statement, not check-then-insert: a second click or a mail client
    // prefetching the link would race a duplicate key. The id is the one
    // Auth just verified, which is what the insert policy checks.
    const created = await insertRow(
      tx,
      appUsers,
      { id: userId, locale: fallbackLocale },
      { onConflict: { target: appUsers.id }, returning: { id: appUsers.id } },
    );

    // `do nothing` returns no row when the user was already there, so the first
    // sign-in is the only one that seeds (RF-64). A user who later accepts an
    // invitation keeps this set: RF-55 gives everyone a personal space, and a
    // group's categories are a separate scope.
    if (created.length > 0) {
      await seedPersonalCategories(tx, { userId, locale: fallbackLocale });
    }

    const [row] = await tx
      .select({ locale: appUsers.locale })
      .from(appUsers)
      .where(eq(appUsers.id, userId))
      .limit(1);

    return row?.locale ?? fallbackLocale;
  });

  const cookieStore = await cookies();
  const postLogin = cookieStore.get("post_login_redirect")?.value;
  cookieStore.delete("post_login_redirect");

  // RF-154: signing in joins nobody; an invitation waits for the person's own tap.
  const target = postLogin && isInternalPath(postLogin) ? postLogin : `/${locale}`;

  return { target, locale };
}
