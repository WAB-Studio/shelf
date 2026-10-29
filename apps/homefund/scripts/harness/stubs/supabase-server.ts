// Injects an identity and grants NOTHING. The claims below only tell
// `withUserDb` whose session to settle; the query still runs as `authenticated`
// over the app pool, so RLS decides every row exactly as it does in a request.
//
// Auth is all the real module is used for, so the stub carries the one method
// `db/session.ts` calls and nothing else.

type HarnessClaims = {
  sub: string;
  email: string;
  role: string;
  aud: string;
};

type HarnessSupabaseClient = {
  auth: {
    getClaims: () => Promise<{ data: { claims: HarnessClaims }; error: null }>;
    // Sends nothing: it records the address, so an invite is driven without mail.
    signInWithOtp: (args: { email: string }) => Promise<{ error: null }>;
  };
};

// Declared with the real module's signature, `responseHeaders` included: the
// harness refreshes no session, so the parameter is never bound.
export const createSupabaseServerClient: (
  responseHeaders?: Headers,
) => Promise<HarnessSupabaseClient> = async () => {
  const sub = process.env.HARNESS_USER_ID;
  // No fallback subject: a run without an identity would query as nobody and
  // report an empty scope as a pass.
  if (!sub) {
    throw new Error(
      "HARNESS_USER_ID is unset — create the harness user before importing any app module",
    );
  }

  const email = process.env.HARNESS_USER_EMAIL ?? `${sub}@harness.invalid`;

  return {
    auth: {
      async getClaims() {
        // A suite that measures whether a route overlaps its session check with
        // its reads sets this; every claims read then costs that long.
        const delay = Number(process.env.HARNESS_CLAIMS_DELAY_MS ?? 0);
        if (delay > 0) await new Promise((done) => setTimeout(done, delay));
        return {
          data: {
            claims: { sub, email, role: "authenticated", aud: "authenticated" },
          },
          error: null,
        };
      },
      async signInWithOtp({ email: to }) {
        const sent = ((globalThis as { harnessInvitesSent?: string[] }).harnessInvitesSent ??= []);
        sent.push(to);
        return { error: null };
      },
    },
  };
};
