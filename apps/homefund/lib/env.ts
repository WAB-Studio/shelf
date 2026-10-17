import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

// The server reaches Postgres through `DATABASE_URL` and Auth through the
// publishable key. The one secret key is RF-148's: only `lib/supabase/admin.ts`
// reads it, because it bypasses every access policy.

// The only reader of `process.env` in the codebase; everything else imports `env`.
export const env = createEnv({
  server: {
    // Supabase transaction pooler (6543), used by the running app.
    DATABASE_URL: z.url(),
    // Supabase session pooler (5432), used by drizzle-kit only.
    MIGRATION_DATABASE_URL: z.url(),
    CRON_SECRET: z.string().min(16),
    // RF-143's ceilings on sign-in links: per caller, then per address.
    SIGN_IN_LINK_DAILY_CLIENT_CAP: z.coerce.number().int().positive().default(5),
    SIGN_IN_LINK_DAILY_ADDRESS_CAP: z.coerce.number().int().positive().default(3),
    // Salts the keys those caps count against, so the IP and the address are never stored.
    CLIENT_KEY_SALT: z.string().min(16).optional(),
    // Auth's admin API for the invitation (RF-148). The prefix check rejects a
    // publishable key or a legacy JWT; without it the invitation is a notice.
    SUPABASE_SECRET_KEY: z.string().startsWith("sb_secret_").optional(),
  },
  client: {
    NEXT_PUBLIC_SUPABASE_URL: z.url(),
    // The prefix check rejects a pasted secret key or a legacy JWT at build time.
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z
      .string()
      .startsWith("sb_publishable_"),
    NEXT_PUBLIC_SITE_URL: z.url(),
  },
  // Client variables are inlined at build time, so they must be spelled out.
  experimental__runtimeEnv: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  },
  emptyStringAsUndefined: true,
});
