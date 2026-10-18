import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

// No privileged Supabase key may reach Postgres here: the server reaches it
// through `DATABASE_URL` and Auth through the publishable key alone. A
// `service_role` key would bypass every RLS policy.
export const env = createEnv({
  server: {
    // Supabase transaction pooler (6543), used by the running app.
    DATABASE_URL: z.url(),
    // Reads a pasted or uploaded plan (RP-37). Unset, the import is off.
    OPENAI_API_KEY: z.string().optional(),
    // Test servers only: answers the plan reader from a fixture, never the model.
    PULSAR_MODEL_STUB: z.string().optional(),
    // Test servers only: answers the chat from a script, never the model.
    PULSAR_CHAT_STUB: z.string().optional(),
    // Daily sign-in-link caps (RP-138): per caller, and per address.
    SIGN_IN_LINK_DAILY_CLIENT_CAP: z.coerce.number().int().positive().default(10),
    SIGN_IN_LINK_DAILY_ADDRESS_CAP: z.coerce.number().int().positive().default(3),
    // Salt the caller key hashes with. Unset, the app still boots.
    CLIENT_KEY_SALT: z.string().min(16).optional(),
  },
  client: {
    NEXT_PUBLIC_SUPABASE_URL: z.url(),
    // The prefix check rejects a pasted privileged key or a legacy JWT at build time.
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
