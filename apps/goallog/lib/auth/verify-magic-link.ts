import { isAuthRetryableFetchError } from "@supabase/supabase-js";

import { consentReturnPath } from "@/lib/validation/oauth";

// Copied from `apps/voyager/lib/auth/verify-magic-link.ts` (RP-18): a
// timeout is the gateway not answering — `verifyOtp` ran but never
// completed, so the token's fate is unknown. `linkInvalid` covers a
// malformed query string and a rejection that did complete: both are
// failures the design attributes to the link, not to us.
export type FailureReason = "linkTimeout" | "linkInvalid";

export type VerifyMagicLinkResult<TUser> =
  | { ok: true; user: TUser }
  | { ok: false; reason: FailureReason; detail: string };

// No `@repo/supabase-auth` import here, on purpose: that package pulls in
// `server-only` and `next/headers`, so a module that imports it cannot load
// outside a running Next server and a check can only grep its source, never
// drive it. `verifyOtp` is passed in instead, so a check can hand it a spy
// and count real invocations.
type VerifyOtp<TParams, TUser> = (
  params: TParams,
) => Promise<{ data: { user: TUser | null }; error: unknown }>;

// The server log's only trace of why a link failed: `reason` folds every
// completed rejection into `linkInvalid`, and a rate limit reads the same there.
function describeAuthError(error: unknown, user: unknown): string {
  if (!error) return user ? "none" : "no user in a success answer";
  const { name, status, code, message } = error as {
    name?: string;
    status?: number;
    code?: string;
    message?: string;
  };
  return [name, status, code, message].filter((part) => part !== undefined).join(" · ");
}

/**
 * Calls `verifyOtp` exactly once — there is no loop and no branch that
 * calls it again — and maps its answer to a reason instead of retrying to
 * find out. `verifyOtp` is not idempotent and a retryable fetch error says
 * nothing about whether the token was spent.
 */
export async function verifyMagicLink<TParams, TUser>(
  verifyOtp: VerifyOtp<TParams, TUser>,
  params: TParams,
): Promise<VerifyMagicLinkResult<TUser>> {
  const { data, error } = await verifyOtp(params);
  if (error || !data.user) {
    return {
      ok: false,
      reason: isAuthRetryableFetchError(error) ? "linkTimeout" : "linkInvalid",
      detail: describeAuthError(error, data.user),
    };
  }
  return { ok: true, user: data.user };
}

/** Where `/auth/confirm` lands after a verified link: the consent it came from, or `/`. */
export function landingAfterSignIn(next: string | null | undefined, siteUrl: string): string {
  return consentReturnPath(next, siteUrl) ?? "/";
}
