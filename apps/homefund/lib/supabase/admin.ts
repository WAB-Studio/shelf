import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";

/**
 * Auth's admin API, for RF-148's invitation alone. The secret key bypasses every
 * access policy, so nothing else may ask for this client, and `server-only`
 * keeps it out of every client bundle.
 *
 * Null without the key: a deploy that lacks it still creates members and
 * surfaces the unsent invitation as a notice.
 */
export function createSupabaseAdminClient(): SupabaseClient | null {
  const key = env.SUPABASE_SECRET_KEY;
  if (!key) return null;
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
