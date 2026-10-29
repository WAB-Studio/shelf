import { createSupabaseServerClient } from "@repo/supabase-auth";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { env } from "@/lib/env";
import { SIGNED_IN_MARKER } from "@/lib/auth/signed-in-marker";
import { landingAfterSignIn, verifyMagicLink, type FailureReason } from "@/lib/auth/verify-magic-link";

const supabaseConfig = {
  url: env.NEXT_PUBLIC_SUPABASE_URL,
  publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
};

// `magiclink` and `signup` are what `signInWithOtp` sends depending on
// whether the address already had an account; `email` covers a custom
// template that names the OTP type directly. `code` is the PKCE link (RP-131);
// `token_hash` stays until the template shared with the other apps moves.
const confirmSchema = z
  .object({
    code: z.string().min(1).optional(),
    token_hash: z.string().min(1).optional(),
    type: z.enum(["magiclink", "signup", "email"]).optional(),
    next: z.string().optional(),
  })
  .refine((query) => query.code !== undefined || (query.token_hash !== undefined && query.type !== undefined));

// Auth's own directives, when `setAll` has run, are kept; `no-store` joins them once.
function withNoStore(response: NextResponse): NextResponse {
  const directives = (response.headers.get("Cache-Control") ?? "")
    .split(",")
    .map((directive) => directive.trim())
    .filter(Boolean);
  if (!directives.some((directive) => directive.toLowerCase() === "no-store")) directives.push("no-store");
  response.headers.set("Cache-Control", directives.join(", "));
  return response;
}

function failure(request: NextRequest, headers: Headers, reason: FailureReason): NextResponse {
  const url = new URL("/entrar", request.url);
  url.searchParams.set("error", reason);

  const response = NextResponse.redirect(url);
  headers.forEach((value, name) => response.headers.set(name, value));
  return withNoStore(response);
}

/**
 * Lands the magic link (RP-18), copied from `apps/wordbook/app/auth/confirm`.
 * No row to seed: there is no `app_users` here, `getPerson()` reads the
 * verified JWT alone.
 */
export async function GET(request: NextRequest) {
  const query = confirmSchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );

  // The no-store directives `setAll` hands back have to ride on the redirect.
  const authHeaders = new Headers();
  // A parse failure never reached Auth, so it is not a timeout.
  if (!query.success) return failure(request, authHeaders, "linkInvalid");

  // Only the browser that asked holds the verifier `@supabase/ssr` set on the request; Auth is not
  // asked from any other.
  if (query.data.code !== undefined) {
    const holdsVerifier = request.cookies.getAll().some(({ name }) => name.endsWith("-code-verifier"));
    if (!holdsVerifier) return failure(request, authHeaders, "linkOtherBrowser");
  }

  const supabase = await createSupabaseServerClient(supabaseConfig, authHeaders);
  const { code, token_hash, type } = query.data;
  const result = await (code !== undefined
    ? verifyMagicLink((authCode: string) => supabase.auth.exchangeCodeForSession(authCode), code)
    : verifyMagicLink((params) => supabase.auth.verifyOtp(params), { type: type!, token_hash: token_hash! }));

  if (!result.ok) {
    console.error("magic link verification failed", result.reason, result.detail);
    return failure(request, authHeaders, result.reason);
  }

  const response = NextResponse.redirect(new URL(landingAfterSignIn(query.data.next, env.NEXT_PUBLIC_SITE_URL), request.url));
  authHeaders.forEach((value, name) => response.headers.set(name, value));
  // Script-readable on purpose (RP-136): the code step reads it, so it is not httpOnly.
  response.cookies.set(SIGNED_IN_MARKER, String(Date.now()), { path: "/", maxAge: 3600, sameSite: "lax" });
  return response;
}
