import { createServerClient } from "@supabase/ssr";
import { hasLocale } from "next-intl";
import createMiddleware from "next-intl/middleware";
import { NextRequest, NextResponse } from "next/server";

import { routing } from "@/i18n/routing";
import {
  inactivityVerdict,
  keepDaysFromClaims,
  LAST_SEEN_COOKIE,
  LAST_SEEN_MAX_AGE,
  parseLastSeen,
} from "@/lib/auth/inactivity";
import { sharedRefreshFetch } from "@/lib/auth/refresh-dedupe";
import { env } from "@/lib/env";

const handleLocaleRouting = createMiddleware(routing);

// The requested path, handed to the signed-in shell. A layout has no other way
// to learn which route is rendering under it, and `app/[locale]/(app)/layout.tsx`
// is the last place that can still set a status: everything below it is wrapped
// by `loading.tsx`'s Suspense boundary. The layout reads this same name back with
// `headers()`, and assertion H40 of `check:http` is what proves the two agree.
const PATHNAME_HEADER = "x-pathname";

// The pathname next-intl settled on, which is what the locale segment is read from.
function resolvedPathname(
  request: NextRequest,
  response: NextResponse,
): string {
  const rewrite = response.headers.get("x-middleware-rewrite");
  return rewrite
    ? new URL(rewrite, request.url).pathname
    : request.nextUrl.pathname;
}

function issuedAt(claims: Record<string, unknown>): number | null {
  return typeof claims.iat === "number" ? claims.iat * 1000 : null;
}

// A redirect that carries `Set-Cookie` and no cache directives is the hole an
// edge cache falls into, handing one member's session to the other.
function carryOver(
  target: NextResponse,
  source: NextResponse,
  headers: Headers,
): NextResponse {
  for (const cookie of source.cookies.getAll()) target.cookies.set(cookie);
  headers.forEach((value, name) => target.headers.set(name, value));

  return target;
}

/**
 * Optimistic gate only: it reads the session cookie and nothing else. The real
 * authorisation is the access policies plus `requireUser()` (RNF-04), so no
 * data layer is imported here.
 */
export async function proxy(request: NextRequest) {
  // A copy of the incoming headers, with the path set (never appended) so a caller
  // cannot smuggle in one of their own. next-intl forwards the request it is
  // handed, so the layout reads this value and the incoming request stays as sent.
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set(PATHNAME_HEADER, request.nextUrl.pathname);
  const forwarded = new NextRequest(request, { headers: forwardedHeaders });

  // The URL first, then Spanish (RF-218); neither the browser nor a cookie picks a language.
  const response = handleLocaleRouting(forwarded);

  // Carried onto whichever response finally leaves this function.
  const headers = new Headers();

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      // Requests arriving together with one expired token share one refresh (RF-190).
      global: { fetch: sharedRefreshFetch() },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, cacheHeaders) {
          for (const { name, value, options } of cookiesToSet) {
            request.cookies.set(name, value);
            response.cookies.set(name, value, options);
          }
          for (const [name, value] of Object.entries(cacheHeaders)) {
            headers.set(name, value);
            response.headers.set(name, value);
          }
        },
      },
    },
  );

  // Before anything commits a response: a refresh landing after the response is
  // written is lost, and the request after it refreshes all over again.
  const { data } = await supabase.auth.getClaims();
  let claims = data?.claims;

  // RF-190: the limit the person chose, counted from this device's last request.
  if (claims) {
    const now = Date.now();
    const verdict = inactivityVerdict({
      // No stamp yet (a device that has not been here since the stamp shipped): the token's own
      // issue time stands in, so the first request is not taken as a visit just now.
      lastSeen: parseLastSeen(request.cookies.get(LAST_SEEN_COOKIE)?.value) ?? issuedAt(claims),
      now,
      days: keepDaysFromClaims(claims),
    });

    if (verdict === "expired") {
      // This device's session alone; the others keep theirs.
      await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
      response.cookies.delete(LAST_SEEN_COOKIE);
      // Whether or not Auth answered the sign-out, this device holds no session any more.
      for (const { name } of request.cookies.getAll()) {
        if (/^sb-.+-auth-token(\.\d+)?$/.test(name)) response.cookies.delete(name);
      }
      claims = undefined;
    } else if (verdict === "stamp") {
      response.cookies.set(LAST_SEEN_COOKIE, String(now), {
        path: "/",
        maxAge: LAST_SEEN_MAX_AGE,
        httpOnly: true,
        sameSite: "lax",
        secure: request.nextUrl.protocol === "https:",
      });
    }
  } else if (request.cookies.has(LAST_SEEN_COOKIE)) {
    // A stale stamp must not sign the next login out at once.
    response.cookies.delete(LAST_SEEN_COOKIE);
  }

  const pathname = resolvedPathname(request, response);
  const segment = pathname.split("/")[1];
  // No locale in the path yet — next-intl is already redirecting to add one.
  if (!hasLocale(routing.locales, segment)) return response;

  const loginPathname = `/${segment}/login`;
  const signedIn = Boolean(claims);

  if (!signedIn && pathname !== loginPathname) {
    const url = new URL(loginPathname, request.url);
    // Keeps the destination across an expired session.
    url.searchParams.set(
      "next",
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
    );

    return carryOver(NextResponse.redirect(url), response, headers);
  }

  if (signedIn && pathname === loginPathname) {
    const url = new URL(`/${segment}`, request.url);

    return carryOver(NextResponse.redirect(url), response, headers);
  }

  return response;
}

export const config = {
  // Route handlers under `/auth` and `/api` own their cookies and must never be
  // locale-prefixed, nor `/oauth/register` and `/oauth/token`, which a client calls with no session
  // (`/oauth/authorize` is a screen and is); the rest is static assets.
  matcher: ["/((?!api|auth|mcp|oauth/register|oauth/token|_next|_vercel|.*\\..*).*)"],
};
