import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

// RF-148 / RF-06. The real `createMemberAction` and `inviteMemberByEmailAction` run; the roster
// write, Auth's server client, Auth's admin client and the env are doubled at module resolution.
// Contract: the invitation is asked of Auth's admin API (`inviteUserByEmail`) with the redirect to
// /login and no `data`; the sign-in code request (`signInWithOtp`) is never made; no admin client,
// or any Auth error (an address Auth already holds included), is a notice (`inviteEmailFailed`)
// while the member stays. Run: node --import tsx --test lib/auth/invite-email.test.ts

type AuthError = { message: string; code?: string; status?: number } | null;

const created: unknown[] = [];
const invited: unknown[][] = [];
const otpCalls: unknown[] = [];
let admin: "none" | "client";
let inviteAnswer: { data: unknown; error: AuthError };
let createFails: unknown;

const double = {
  createMember: async (input: unknown) => {
    if (createFails) throw createFails;
    created.push(input);
    return { memberId: "11111111-1111-4111-8111-111111111111" };
  },
  admin: () =>
    admin === "none"
      ? null
      : {
          auth: {
            admin: {
              inviteUserByEmail: async (...args: unknown[]) => {
                invited.push(args);
                return inviteAnswer;
              },
            },
          },
        },
  server: async () => ({
    auth: {
      signInWithOtp: async (params: unknown) => {
        otpCalls.push(params);
        return { error: null };
      },
    },
  }),
};
(globalThis as unknown as { __inviteDouble: typeof double }).__inviteDouble = double;
const D = "globalThis.__inviteDouble";

const DOUBLES: Record<string, string> = {
  "server-only": "export {};",
  "next/cache": `export const refresh = () => {};`,
  "@/db/queries/group-members": `export const createMember = (...a) => ${D}.createMember(...a);
    export const archiveMember = async () => {}; export const deleteMember = async () => {};
    export const restoreMember = async () => {}; export const transferLeadership = async () => {};
    export const updateMember = async () => {};`,
  "@/db/queries/groups": `export const getUserGroup = async () => ({ id: "group-1" });`,
  "@/lib/env": `export const env = { NEXT_PUBLIC_SUPABASE_URL: "http://stub.invalid", NEXT_PUBLIC_SITE_URL: "http://site.invalid" };`,
  "@/lib/safe-action": `import { createSafeActionClient } from "next-safe-action";
    export const actionClient = createSafeActionClient({ defaultValidationErrorsShape: "flattened", handleServerError: (e) => e.messageKey ?? "errors.unexpected" });
    export const authActionClient = actionClient;`,
  "@/lib/supabase/server": `export const createSupabaseServerClient = (...a) => ${D}.server(...a);`,
  "@/lib/supabase/admin": `export const createSupabaseAdminClient = (...a) => ${D}.admin(...a);`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in DOUBLES) return { url: `double:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("double:")) {
      return { format: "module", source: DOUBLES[url.slice("double:".length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const EMAIL = "persona@example.com";

async function actions() {
  return import("../../app/actions/members");
}

beforeEach(() => {
  created.length = 0;
  invited.length = 0;
  otpCalls.length = 0;
  admin = "client";
  createFails = undefined;
  inviteAnswer = { data: { user: { id: "u" } }, error: null };
});

// Mutation: restore signInWithOtp, or ask for the redirect /auth/confirm.
test("an invitation asks Auth's admin API once, redirected to /login, with no data, and never requests a code", async () => {
  const { createMemberAction } = await actions();
  const result = await createMemberAction({ name: "Ana", email: EMAIL });
  assert.deepEqual(result?.data, {
    memberId: "11111111-1111-4111-8111-111111111111",
    inviteEmailFailed: false,
  });
  assert.deepEqual(invited, [[EMAIL, { redirectTo: "http://site.invalid/login" }]]);
  assert.equal(otpCalls.length, 0);
});

// Mutation: pass `{ data: { inviter } }`.
test("the onboarding invite sends the same invitation and no code", async () => {
  const { inviteMemberByEmailAction } = await actions();
  const result = await inviteMemberByEmailAction({ email: EMAIL });
  assert.equal(result?.data?.inviteEmailFailed, false);
  assert.deepEqual(invited, [[EMAIL, { redirectTo: "http://site.invalid/login" }]]);
  assert.equal(otpCalls.length, 0);
  assert.equal(created.length, 1);
});

// Mutation: throw instead of returning false when there is no admin client.
test("no admin client: the member is kept, the notice is raised, nothing is sent and no code is asked", async () => {
  admin = "none";
  const { createMemberAction, inviteMemberByEmailAction } = await actions();
  const a = await createMemberAction({ name: "Ana", email: EMAIL });
  assert.equal(a?.serverError, undefined);
  assert.equal(a?.data?.inviteEmailFailed, true);
  const b = await inviteMemberByEmailAction({ email: EMAIL });
  assert.equal(b?.serverError, undefined);
  assert.equal(b?.data?.inviteEmailFailed, true);
  assert.equal(created.length, 2, "both members were written");
  assert.equal(invited.length, 0);
  assert.equal(otpCalls.length, 0, "no fallback to the code mail");
});

// Mutation: treat email_exists as success.
test("an address Auth already holds raises the notice and keeps the member", async () => {
  inviteAnswer = {
    data: { user: null },
    error: { message: "A user with this email address has already been registered", code: "email_exists", status: 422 },
  };
  const { createMemberAction } = await actions();
  const result = await createMemberAction({ name: "Ana", email: EMAIL });
  assert.equal(result?.data?.inviteEmailFailed, true);
  assert.equal(created.length, 1);
  assert.equal(otpCalls.length, 0);
});

// Mutation: succeed on error only when the status is 4xx.
test("any other Auth error raises the notice too", async () => {
  inviteAnswer = { data: { user: null }, error: { message: "boom", status: 500 } };
  const { inviteMemberByEmailAction } = await actions();
  const result = await inviteMemberByEmailAction({ email: EMAIL });
  assert.equal(result?.data?.inviteEmailFailed, true);
  assert.equal(created.length, 1);
});

// Mutation: invite even when the address is blank.
test("a member with no address asks Auth for nothing", async () => {
  const { createMemberAction } = await actions();
  const result = await createMemberAction({ name: "Ana" });
  assert.equal(result?.data?.inviteEmailFailed, false);
  assert.equal(invited.length, 0);
  assert.equal(otpCalls.length, 0);
});

// RF-149. The unique index on (group, lower(invite_email)) raises 23505 in the roster write; the
// driver error sits under drizzle's `.cause`, as in production.
function pgError(code: string) {
  return Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("pg"), { code }) });
}

const BOTH = [
  ["createMemberAction", (a: Awaited<ReturnType<typeof actions>>) => a.createMemberAction({ name: "Ana", email: EMAIL })],
  ["inviteMemberByEmailAction", (a: Awaited<ReturnType<typeof actions>>) => a.inviteMemberByEmailAction({ email: EMAIL })],
] as const;

for (const [name, run] of BOTH) {
  // Mutation: drop the 23505 branch; or map it in only one action.
  test(`${name}: a pending address in the group is refused by name and no mail is sent`, async () => {
    createFails = pgError("23505");
    const result = await run(await actions());
    assert.equal(result?.serverError, "members.errors.emailTaken");
    assert.equal(result?.data, undefined);
    assert.equal(invited.length, 0, "no invitation on a refusal");
    assert.equal(otpCalls.length, 0);
    assert.equal(created.length, 0);
  });

  // Mutation: swap the two codes.
  test(`${name}: 42501 is still the not-leader refusal`, async () => {
    createFails = pgError("42501");
    const result = await run(await actions());
    assert.equal(result?.serverError, "errors.notLeader");
    assert.equal(invited.length, 0);
  });

  // Mutation: map every pg error to emailTaken.
  test(`${name}: any other database error is not the emailTaken refusal`, async () => {
    createFails = pgError("23514");
    const result = await run(await actions());
    assert.notEqual(result?.serverError, "members.errors.emailTaken");
    assert.notEqual(result?.serverError, "errors.notLeader");
    assert.equal(invited.length, 0);
  });
}
