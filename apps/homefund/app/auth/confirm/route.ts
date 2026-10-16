import { eq } from "drizzle-orm";
import { hasLocale } from "next-intl";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { insertRow } from "@/db/insert-row";
import { claimInviteForUser } from "@/db/queries/group-members";
import { seedPersonalCategories } from "@/db/queries/personal-space";
import { appUsers } from "@/db/schema";
import { withUserDb } from "@/db/session";
import { routing } from "@/i18n/routing";
import { isInternalPath } from "@/lib/internal-path";
import { DEFAULT_LOCALE, type Locale } from "@/lib/locales";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

// `magiclink` and `signup` are what the current email templates send. `email`
// is the single value the documented templates use, accepted so that editing a
// template later needs no code change.
const confirmSchema = z.object({
  token_hash: z.string().min(1),
  type: z.enum(["magiclink", "signup", "email"]),
});

function applyHeaders(response: NextResponse, headers: Headers): NextResponse {
  headers.forEach((value, name) => response.headers.set(name, value));
  return response;
}

function invalidLink(
  request: NextRequest,
  locale: Locale,
  headers: Headers,
): NextResponse {
  const url = new URL(`/${locale}/login`, request.url);
  url.searchParams.set("error", "linkInvalid");

  return applyHeaders(NextResponse.redirect(url), headers);
}

/**
 * Lands the magic link (RF-01). Outside the proxy matcher, so the locale comes
 * from the user's own row rather than the URL — `next/root-params` is not
 * available here.
 */
export async function GET(request: NextRequest) {
  const cookieValue = request.cookies.get("NEXT_LOCALE")?.value;
  const fallbackLocale = hasLocale(routing.locales, cookieValue)
    ? cookieValue
    : DEFAULT_LOCALE;

  // The no-store directives `setAll` hands back have to ride on the redirect.
  const authHeaders = new Headers();

  const query = confirmSchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!query.success) return invalidLink(request, fallbackLocale, authHeaders);

  const supabase = await createSupabaseServerClient(authHeaders);
  const { data, error } = await supabase.auth.verifyOtp({
    type: query.data.type,
    token_hash: query.data.token_hash,
  });

  if (error || !data.user) {
    console.error("magic link verification failed", error);
    return invalidLink(request, fallbackLocale, authHeaders);
  }

  const userId = data.user.id;

  const locale = await withUserDb(async (tx) => {
    // One statement, not check-then-insert: a second click or a mail client
    // prefetching the link would race a duplicate key. The id is the one
    // `verifyOtp` just verified, which is what the insert policy checks.
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

  // RF-06: link this user to the pending member their magic link's email matches,
  // if any. Runs under their now-verified session, which is the only identity the
  // claim reads; "none"/"already-in-group" fall through to the usual landing.
  const claim = await claimInviteForUser({ email: data.user.email ?? "" });

  const cookieStore = await cookies();
  const postLogin = cookieStore.get("post_login_redirect")?.value;
  cookieStore.delete("post_login_redirect");

  const target =
    claim === "claimed"
      ? `/${locale}/bienvenida`
      : postLogin && isInternalPath(postLogin)
        ? postLogin
        : `/${locale}`;

  const response = applyHeaders(
    NextResponse.redirect(new URL(target, request.url)),
    authHeaders,
  );
  // Keeps the proxy on the same language for the very next request.
  response.cookies.set("NEXT_LOCALE", locale, {
    path: "/",
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: "lax",
  });

  return response;
}
