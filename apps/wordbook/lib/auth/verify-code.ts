import { isAuthRetryableFetchError } from "@supabase/supabase-js";

export type CodeFailure = "codeInvalid" | "codeTimeout" | "rateLimited";
export type VerifyCodeResult<TUser> = { ok: true; user: TUser } | { ok: false; reason: CodeFailure };
type VerifyOtp<TUser> = (params: { email: string; token: string; type: "email" }) => Promise<{ data: { user: TUser | null }; error: unknown }>;

// RL-73: Auth's own 429 reads apart from a wrong code; a retryable error
// is never retried because the code may already be spent (docs/TRAPS.md).
function isRateLimited(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { status?: unknown }).status === 429;
}

export async function verifyCode<TUser>(verifyOtp: VerifyOtp<TUser>, { email, code }: { email: string; code: string }): Promise<VerifyCodeResult<TUser>> {
  const { data, error } = await verifyOtp({ email, token: code, type: "email" });
  if (error || !data.user) {
    if (isAuthRetryableFetchError(error)) return { ok: false, reason: "codeTimeout" };
    if (isRateLimited(error)) return { ok: false, reason: "rateLimited" };
    return { ok: false, reason: "codeInvalid" };
  }
  return { ok: true, user: data.user };
}
