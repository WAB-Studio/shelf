import { isAuthRetryableFetchError } from "@supabase/supabase-js";

// RP-136: `codeInvalid` is a rejection that completed (wrong or expired); `codeTimeout` is the
// gateway not answering, so the code's fate is unknown; `rateLimited` is Auth's own 429.
export type CodeFailureReason = "codeInvalid" | "codeTimeout" | "rateLimited";

export type VerifyCodeResult<TUser> =
  | { ok: true; user: TUser }
  | { ok: false; reason: CodeFailureReason; detail: string };

// No `@repo/supabase-auth` import, so a test can drive this with a spy in plain Node.
type VerifyOtp<TUser> = (params: {
  email: string;
  token: string;
  type: "email";
}) => Promise<{ data: { user: TUser | null }; error: unknown }>;

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
 * Calls `verifyOtp` exactly once and maps its answer to a reason. `verifyOtp` spends the code, and a
 * retryable fetch error says nothing about whether it was spent, so nothing here retries.
 */
export async function verifyCode<TUser>(
  verifyOtp: VerifyOtp<TUser>,
  { email, code }: { email: string; code: string },
): Promise<VerifyCodeResult<TUser>> {
  const { data, error } = await verifyOtp({ email, token: code, type: "email" });
  if (!error && data.user) return { ok: true, user: data.user };

  const status = (error as { status?: number } | null)?.status;
  const reason: CodeFailureReason = isAuthRetryableFetchError(error)
    ? "codeTimeout"
    : status === 429
      ? "rateLimited"
      : "codeInvalid";
  return { ok: false, reason, detail: describeAuthError(error, data.user) };
}
