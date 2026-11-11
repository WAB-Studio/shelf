import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export type SupabaseConfig = {
  url: string;
  publishableKey: string;
  /** Replaces the client's `fetch`; an app uses it to keep this client from refreshing a token. */
  fetch?: typeof fetch;
};

/**
 * Auth only. Callers with the Data API off — `.from`, `.rpc` and storage —
 * still get every row through their own ORM, not this client.
 *
 * `responseHeaders` is the sink for the no-store directives that must ride
 * along with a refreshed session. Next exposes no writable response headers to
 * a Server Component or Server Action, so only a route handler or middleware —
 * which hold a real response — can supply one.
 */
export async function createSupabaseServerClient(
  config: SupabaseConfig,
  responseHeaders?: Headers,
) {
  const cookieStore = await cookies();

  return createServerClient(config.url, config.publishableKey, {
    ...(config.fetch ? { global: { fetch: config.fetch } } : null),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet, headers) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
          // Without these a CDN may cache the `Set-Cookie` response and hand
          // one user's session to another.
          for (const [name, value] of Object.entries(headers)) {
            responseHeaders?.set(name, value);
          }
        } catch {
          // Rendering a Server Component: the session is refreshed by the
          // caller's own middleware on the next request instead.
        }
      },
    },
  });
}
