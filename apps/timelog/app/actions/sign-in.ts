"use server";

import { createSupabaseServerClient } from "@repo/supabase-auth";

import { isEmailAllowed } from "@/lib/auth";
import { signInEmailSchema } from "@/lib/forms";
import { env } from "@/lib/env";

export type SignInResult = { ok: true } | { ok: false; error: "emailInvalid" | "notInvited" | "sendFailed" | "rateLimited" };

// Asks for the sign-in link (RT-08). Sign-up stays closed: Auth refuses a listed address with no user.
export async function sendSignInLink(email: string): Promise<SignInResult> {
  const parsed = signInEmailSchema.safeParse(email);
  if (!parsed.success) return { ok: false, error: "emailInvalid" };
  if (!(await isEmailAllowed(parsed.data))) return { ok: false, error: "notInvited" };

  const supabase = await createSupabaseServerClient({
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data,
    options: { shouldCreateUser: false, emailRedirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/confirm` },
  });
  if (error) {
    console.error("sign-in link request failed", error);
    return { ok: false, error: error.status === 429 ? "rateLimited" : "sendFailed" };
  }
  return { ok: true };
}
