"use server";

import { hasLocale } from "next-intl";
import { getLocale } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { redirect as nextRedirect } from "next/navigation";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { z } from "zod";

import { isEmailAllowed } from "@/db/queries/allowlist";
import { claimSignInLink, releaseSignInLink } from "@/db/queries/sign-in-claims";
import { redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { landSession } from "@/lib/auth/land-session";
import { verifySignInCode } from "@/lib/auth/verify-code";
import { deliverabilityExempt, isDomainDeliverable } from "@/lib/auth/deliverability";
import { env } from "@/lib/env";
import { ActionError } from "@/lib/errors";
import { isInternalPath } from "@/lib/internal-path";
import { DEFAULT_LOCALE, type Locale } from "@/lib/locales";
import { actionClient, authActionClient } from "@/lib/safe-action";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { signInCodeSchema, signInSchema } from "@/lib/validation/auth";

const POST_LOGIN_REDIRECT_MAX_AGE = 60 * 15;
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Sends the sign-in link (RF-01). The bind argument carries the destination the
 * proxy put in `?next=`; the form itself only holds the email. Every refusal
 * lands before Auth is asked, cheapest first, and the daily caps (RF-143) last
 * so that an uninvited or undeliverable address never spends a claim.
 */
export const signInAction = actionClient
  .bindArgsSchemas([z.string().optional()])
  .inputSchema(signInSchema)
  .action(async ({ parsedInput: { email }, bindArgsParsedInputs: [next] }) => {
    // RF-145: only invited addresses get a link.
    if (!(await isEmailAllowed(email))) throw new ActionError("errors.notInvited");

    const domain = email.trim().toLowerCase().split("@").pop() ?? "";
    const deliverable =
      deliverabilityExempt(domain, env.NEXT_PUBLIC_SUPABASE_URL) || (await isDomainDeliverable(domain));
    if (!deliverable) throw new ActionError("errors.domainUndeliverable");

    // `noKey` passes: Auth's own per-hour limit still stands behind it.
    const claim = await claimSignInLink(await headers(), email);
    if (claim.status === "rateLimited") throw new ActionError("errors.signInLinkCapped");

    const supabase = await createSupabaseServerClient();

    const { error } = await supabase.auth.signInWithOtp({
      email,
      // No `data`: it would land in `raw_user_meta_data`, which the user can
      // rewrite and which surfaces in the JWT. User state lives in `app_users`.
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/confirm`,
      },
    });

    if (error) {
      console.error("sign-in link request failed", error);
      // A timeout may have left the mail, so it keeps the claim; any other refusal hands it back.
      if (claim.status === "ok" && !isAuthRetryableFetchError(error)) {
        await releaseSignInLink(claim.claimed);
      }
      throw new ActionError(
        error.status === 429 || error.code === "over_email_send_rate_limit"
          ? "errors.emailRateLimited"
          : "errors.unexpected",
      );
    }

    if (next && isInternalPath(next)) {
      const cookieStore = await cookies();
      cookieStore.set("post_login_redirect", next, {
        path: "/",
        maxAge: POST_LOGIN_REDIRECT_MAX_AGE,
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV !== "development",
      });
    }

    // Identical whether or not that address already has an account: the answer
    // must not tell a stranger who is registered.
    return { sent: true };
  });

/**
 * Verifies the six-digit code the person typed (RF-146) and lands them where
 * the link would have. Nothing is sent here, so no list, DNS or cap check: the
 * code was already behind them. Auth is asked once; a refusal is a reason.
 */
export const verifyCodeAction = actionClient
  .inputSchema(signInCodeSchema)
  .action(async ({ parsedInput: { email, code } }) => {
    const supabase = await createSupabaseServerClient();
    const result = await verifySignInCode((params) => supabase.auth.verifyOtp(params), { email, code });
    if (!result.ok) throw new ActionError(`errors.${result.reason}`);

    const requestLocale = await getLocale();
    const fallbackLocale: Locale = hasLocale(routing.locales, requestLocale) ? requestLocale : DEFAULT_LOCALE;
    const { target, locale } = await landSession({ user: result.user, fallbackLocale });

    const cookieStore = await cookies();
    cookieStore.set("NEXT_LOCALE", locale, {
      path: "/",
      maxAge: LOCALE_COOKIE_MAX_AGE,
      sameSite: "lax",
    });

    // `target` already carries its locale prefix, so the plain redirect, not the localized one.
    nextRedirect(target);
  });

export const signOutAction = authActionClient.action(async () => {
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.auth.signOut();
  // `signOut` drops this device's cookies even when Auth kept the session, so the person is out here: say what is left.
  if (error) {
    console.error("sign-out failed", error);
    redirect({ href: { pathname: "/login", query: { error: "signOutPartial" } }, locale: await getLocale() });
  }

  redirect({ href: "/login", locale: await getLocale() });
});
