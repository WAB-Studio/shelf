import "server-only";

import { createSupabaseServerClient as createClient } from "@repo/supabase-auth";

import { neverRefreshFetch } from "@/lib/auth/no-refresh";
import { env } from "@/lib/env";

/**
 * Auth only. The Data API is off for this project, so `.from`, `.rpc` and
 * storage would fail at runtime; every row reaches a screen through Drizzle.
 *
 * `responseHeaders` is the sink for the no-store directives that must ride
 * along with a refreshed session. Next exposes no writable response headers to
 * a Server Component or Server Action, so only the proxy and Route Handlers —
 * which hold a real response — can supply one.
 *
 * Never refreshes a session: the proxy is the only place that does (RF-190), because it alone can
 * write the rotated cookie back.
 *
 * The seam the harness stub replaces, so every module that needs an auth client
 * asks here rather than reaching for the package.
 */
export async function createSupabaseServerClient(responseHeaders?: Headers) {
  return createClient(
    {
      url: env.NEXT_PUBLIC_SUPABASE_URL,
      publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      fetch: neverRefreshFetch(),
    },
    responseHeaders,
  );
}
