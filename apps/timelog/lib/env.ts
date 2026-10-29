import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

// No privileged Supabase key reaches Postgres here: the server goes through
// `DATABASE_URL` and Auth through the publishable key alone.
export const env = createEnv({
  server: {
    DATABASE_URL: z.url(),
  },
  client: {
    NEXT_PUBLIC_SUPABASE_URL: z.url(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().startsWith("sb_publishable_"),
    NEXT_PUBLIC_SITE_URL: z.url(),
  },
  experimental__runtimeEnv: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  },
  emptyStringAsUndefined: true,
});
