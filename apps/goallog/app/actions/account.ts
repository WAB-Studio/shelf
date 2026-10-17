"use server";

import { redirect } from "next/navigation";

import { isEmailAllowed } from "@/lib/auth/allowlist";
import { isDomainDeliverable } from "@/lib/auth/deliverability";
import { landingAfterSignIn } from "@/lib/auth/verify-magic-link";
import { verifyCode } from "@/lib/auth/verify-code";
import { consentReturnPath } from "@/lib/validation/oauth";
import { signInCodeSchema, signInEmailSchema } from "@/lib/validation/sign-in";

// `@repo/supabase-auth` starts with `import "server-only"`, and `@/lib/env`
// throws when its required vars are unset — both resolvable only inside
// Next's own build. A plain Node import (a check driving `isDomainDeliverable`
// on its own below) dies on either. Deferred so importing this file to reach
// that check never has to load them.
async function supabaseClient() {
  const [{ createSupabaseServerClient }, { env }] = await Promise.all([
    import("@repo/supabase-auth"),
    import("@/lib/env"),
  ]);
  return createSupabaseServerClient({
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}

export type SendSignInLinkResult =
  | { ok: true }
  | { ok: false; error: "emailInvalid" | "notInvited" | "domainUndeliverable" | "sendFailed" | "rateLimited" };

/**
 * Asks for the sign-in link (RP-18). No `data` on the call: it would land in
 * `raw_user_meta_data`, which the user can rewrite and which surfaces in the
 * JWT — there is no row of this app's own for state to live in instead.
 */
export async function sendSignInLink(email: string, next?: string): Promise<SendSignInLinkResult> {
  const parsed = signInEmailSchema.safeParse(email);
  if (!parsed.success) return { ok: false, error: "emailInvalid" };

  // Before DNS and Auth: an address off the list costs neither a lookup nor a send.
  if (!(await isEmailAllowed(parsed.data))) return { ok: false, error: "notInvited" };

  const domain = parsed.data.slice(parsed.data.lastIndexOf("@") + 1);
  // Before Supabase ever sees the address: a domain that cannot take mail
  // must not get a row in `auth.users` or a send against the project's own
  // quota, both spent whether or not the message can land.
  if (!(await isDomainDeliverable(domain))) return { ok: false, error: "domainUndeliverable" };

  const [supabase, { env }] = await Promise.all([supabaseClient(), import("@/lib/env")]);

  // A `next` that is not the consent never rides in the link.
  const back = consentReturnPath(next, env.NEXT_PUBLIC_SITE_URL);
  const redirect = new URL(`${env.NEXT_PUBLIC_SITE_URL}/auth/confirm`);
  if (back) redirect.searchParams.set("next", back);

  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: redirect.toString(),
    },
  });

  if (error) {
    console.error("sign-in link request failed", error);
    // 429 (over_email_send_rate_limit) names the wait, not just the
    // failure to send — every other status keeps the generic copy.
    return { ok: false, error: error.status === 429 ? "rateLimited" : "sendFailed" };
  }

  // Identical whether or not that address already has an account: the answer
  // must not tell a stranger who is registered.
  return { ok: true };
}

export type VerifySignInCodeResult = {
  ok: false;
  error: "emailInvalid" | "codeShape" | "codeInvalid" | "codeTimeout" | "rateLimited";
};

/**
 * Turns the address and its six-digit code into a session (RP-136) and lands the person on the
 * consent they came from, or `/`. Auth is asked once: the code is spent by the asking.
 */
export async function verifySignInCode(email: string, code: string, next?: string): Promise<VerifySignInCodeResult> {
  const parsedEmail = signInEmailSchema.safeParse(email);
  if (!parsedEmail.success) return { ok: false, error: "emailInvalid" };
  const parsedCode = signInCodeSchema.safeParse(code);
  if (!parsedCode.success) return { ok: false, error: "codeShape" };

  const [supabase, { env }] = await Promise.all([supabaseClient(), import("@/lib/env")]);
  const result = await verifyCode((params) => supabase.auth.verifyOtp(params), {
    email: parsedEmail.data,
    code: parsedCode.data,
  });
  if (!result.ok) {
    console.error("sign-in code verification failed", result.reason, result.detail);
    return { ok: false, error: result.reason };
  }

  redirect(landingAfterSignIn(next, env.NEXT_PUBLIC_SITE_URL));
}
