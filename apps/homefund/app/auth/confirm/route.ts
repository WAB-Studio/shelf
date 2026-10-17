import { hasLocale } from "next-intl";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { routing } from "@/i18n/routing";
import { landSession } from "@/lib/auth/land-session";
import { DEFAULT_LOCALE, type Locale } from "@/lib/locales";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

// `code` is the PKCE link `signInWithOtp` now sends. `token_hash` stays for the
// invitation mail and any link already in an inbox. `magiclink` and `signup` are
// what the current email templates send. `email` is the single value the
// documented templates use, accepted so that editing a template later needs no
// code change.
const confirmSchema = z
  .object({
    code: z.string().min(1).optional(),
    token_hash: z.string().min(1).optional(),
    type: z.enum(["magiclink", "signup", "email"]).optional(),
  })
  .refine((query) => query.code !== undefined || (query.token_hash !== undefined && query.type !== undefined));

type LinkFailure = "linkInvalid" | "linkOtherBrowser";

function applyHeaders(response: NextResponse, headers: Headers): NextResponse {
  headers.forEach((value, name) => response.headers.set(name, value));
  return response;
}

function invalidLink(
  request: NextRequest,
  locale: Locale,
  headers: Headers,
  reason: LinkFailure = "linkInvalid",
): NextResponse {
  const url = new URL(`/${locale}/login`, request.url);
  url.searchParams.set("error", reason);

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

  const { code, token_hash, type } = query.data;

  // Only the browser that asked holds the verifier `@supabase/ssr` set when the
  // link was requested; from any other, Auth is not asked and the code stays
  // unspent for the browser that can use it.
  if (code !== undefined) {
    const holdsVerifier = request.cookies.getAll().some(({ name }) => name.endsWith("-code-verifier"));
    if (!holdsVerifier) return invalidLink(request, fallbackLocale, authHeaders, "linkOtherBrowser");
  }

  const supabase = await createSupabaseServerClient(authHeaders);
  const { data, error } =
    code !== undefined
      ? await supabase.auth.exchangeCodeForSession(code)
      : await supabase.auth.verifyOtp({ type: type!, token_hash: token_hash! });

  if (error || !data.user) {
    console.error("magic link verification failed", error);
    return invalidLink(request, fallbackLocale, authHeaders);
  }

  const { target, locale } = await landSession({ user: data.user, fallbackLocale });

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
