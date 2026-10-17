import { isAuthRetryableFetchError } from "@supabase/supabase-js";

// RF-146: `codeTimeout` is Auth not answering, so the code's fate is unknown;
// `codeRateLimited` is Auth's own attempt limit; `codeInvalid` is everything
// else, a wrong or expired code among them.
export type CodeFailure = "codeInvalid" | "codeTimeout" | "codeRateLimited";

export type VerifySignInCodeResult<TUser> = { ok: true; user: TUser } | { ok: false; reason: CodeFailure };

type VerifyOtp<TUser> = (params: {
  email: string;
  token: string;
  type: "email";
}) => Promise<{ data: { user: TUser | null }; error: unknown }>;

function isRateLimited(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 429 || code === "over_request_rate_limit";
}

/**
 * Calls `verifyOtp` exactly once and maps its answer to a reason. A code is
 * spent by the call, so no branch asks again (docs/TRAPS.md). `verifyOtp` is
 * injected so a spec can count real invocations without reaching Auth.
 */
export async function verifySignInCode<TUser>(
  verifyOtp: VerifyOtp<TUser>,
  { email, code }: { email: string; code: string },
): Promise<VerifySignInCodeResult<TUser>> {
  const { data, error } = await verifyOtp({ email, token: code, type: "email" });
  if (error || !data.user) {
    if (isAuthRetryableFetchError(error)) return { ok: false, reason: "codeTimeout" };
    if (isRateLimited(error)) return { ok: false, reason: "codeRateLimited" };
    return { ok: false, reason: "codeInvalid" };
  }
  return { ok: true, user: data.user };
}
