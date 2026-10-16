"use server";

import { getLocale } from "next-intl/server";
import { cookies } from "next/headers";
import { z } from "zod";

import { redirect } from "@/i18n/navigation";
import { env } from "@/lib/env";
import { ActionError } from "@/lib/errors";
import { isInternalPath } from "@/lib/internal-path";
import { actionClient, authActionClient } from "@/lib/safe-action";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { signInSchema } from "@/lib/validation/auth";

const POST_LOGIN_REDIRECT_MAX_AGE = 60 * 15;

/**
 * Sends the sign-in link (RF-01). The bind argument carries the destination the
 * proxy put in `?next=`; the form itself only holds the email.
 */
export const signInAction = actionClient
  .bindArgsSchemas([z.string().optional()])
  .inputSchema(signInSchema)
  .action(async ({ parsedInput: { email }, bindArgsParsedInputs: [next] }) => {
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

export const signOutAction = authActionClient.action(async () => {
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.auth.signOut();
  // Logged, not surfaced: the session is gone from this browser either way.
  if (error) console.error("sign-out failed", error);

  redirect({ href: "/login", locale: await getLocale() });
});
