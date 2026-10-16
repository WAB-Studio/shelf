import { createServerClient } from "@supabase/ssr";
import { hasLocale } from "next-intl";
import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";

import { routing } from "@/i18n/routing";
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
  // Set before next-intl runs, which clones these onto the request it forwards,
  // and set on every request, so a caller cannot smuggle in a path of their own.
  request.headers.set(PATHNAME_HEADER, request.nextUrl.pathname);

  // URL first, then the `NEXT_LOCALE` cookie, then `accept-language`, then Spanish.
  const response = handleLocaleRouting(request);

  // Carried onto whichever response finally leaves this function.
  const headers = new Headers();

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
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

  const pathname = resolvedPathname(request, response);
  const segment = pathname.split("/")[1];
  // No locale in the path yet — next-intl is already redirecting to add one.
  if (!hasLocale(routing.locales, segment)) return response;

  const loginPathname = `/${segment}/login`;
  const signedIn = Boolean(data?.claims);

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
  // locale-prefixed; the rest is static assets.
  matcher: ["/((?!api|auth|_next|_vercel|.*\\..*).*)"],
};
