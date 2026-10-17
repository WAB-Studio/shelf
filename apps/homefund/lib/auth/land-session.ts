import "server-only";

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";

import { insertRow } from "@/db/insert-row";
import { claimInviteForUser } from "@/db/queries/group-members";
import { seedPersonalCategories } from "@/db/queries/personal-space";
import { appUsers } from "@/db/schema";
import { withUserDb } from "@/db/session";
import { isInternalPath } from "@/lib/internal-path";
import type { Locale } from "@/lib/locales";

/**
 * Lands a verified session (RF-01, RF-146): the same for the link and the
 * code. Writes the `app_users` row, seeds on the first sign-in, claims a
 * pending invitation, and returns where the person goes next.
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
    // sign-in is the only one that seeds (RF-64). A user who goes on to claim an
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

  // RF-06: link this user to the pending member their email matches, if any.
  // Runs under their now-verified session, which is the only identity the
  // claim reads; "none"/"already-in-group" fall through to the usual landing.
  const claim = await claimInviteForUser({ email: user.email ?? "" });

  const cookieStore = await cookies();
  const postLogin = cookieStore.get("post_login_redirect")?.value;
  cookieStore.delete("post_login_redirect");

  const target =
    claim === "claimed"
      ? `/${locale}/bienvenida`
      : postLogin && isInternalPath(postLogin)
        ? postLogin
        : `/${locale}`;

  return { target, locale };
}
