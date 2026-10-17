// Sends nothing: it records each invitation the admin API is asked for, so an
// invite is driven without mail and without the secret key.

type HarnessInvite = { email: string; redirectTo?: string };

type HarnessSupabaseAdminClient = {
  auth: {
    admin: {
      inviteUserByEmail: (
        email: string,
        options?: { redirectTo?: string; data?: object },
      ) => Promise<{ data: { user: null }; error: null }>;
    };
  };
};

export function createSupabaseAdminClient(): HarnessSupabaseAdminClient {
  return {
    auth: {
      admin: {
        async inviteUserByEmail(email, options) {
          const asked = ((globalThis as { harnessAdminInvites?: HarnessInvite[] }).harnessAdminInvites ??= []);
          asked.push({ email, redirectTo: options?.redirectTo });
          return { data: { user: null }, error: null };
        },
      },
    },
  };
}
