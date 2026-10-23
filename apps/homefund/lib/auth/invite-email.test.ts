import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

import { updateMemberSchema } from "../validation/member";

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
let restoreFails: unknown;
let restoreAnswer: boolean;
let isMember: boolean;
let mxAnswer: "mail" | "nullMx" | "servfail";
// Every double that is asked records its name, then waits at `gate` while a test holds it shut.
const entered: string[] = [];
let gate: Promise<void> = Promise.resolve();
let memberAsked: string[] = [];
const updates: { groupId: string; memberId: string; name: string; inviteEmail?: string }[] = [];
let updateAnswer: unknown;
let updateFails: unknown;
let mxAsked = 0;
let groupAsked = 0;

const double = {
  restoreMember: async () => {
    if (restoreFails) throw restoreFails;
    return restoreAnswer;
  },
  group: async () => {
    groupAsked++;
    entered.push("group");
    await gate;
    return { id: "group-1" };
  },
  isMember: async (email: string) => {
    memberAsked.push(email);
    entered.push("member");
    await gate;
    return isMember;
  },
  resolveMx: async () => {
    mxAsked++;
    entered.push("dns");
    await gate;
    if (mxAnswer === "servfail") throw Object.assign(new Error("servfail"), { code: "ESERVFAIL" });
    return mxAnswer === "nullMx" ? [{ exchange: "", priority: 0 }] : [{ exchange: "mx.mail.test", priority: 10 }];
  },
  updateMember: async (input: { groupId: string; memberId: string; name: string; inviteEmail?: string }) => {
    entered.push("update");
    if (updateFails) throw updateFails;
    updates.push(input);
    return updateAnswer ?? (input.inviteEmail ? "updated" : true);
  },
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
    export const restoreMember = (...a) => ${D}.restoreMember(...a); export const transferLeadership = async () => {};
    export const updateMember = (...a) => ${D}.updateMember(...a);
    export const inviteEmailIsMember = (...a) => ${D}.isMember(...a);`,
  "@/db/queries/groups": `export const getUserGroup = (...a) => ${D}.group(...a);`,
  "node:dns/promises": `export const resolveMx = (...a) => ${D}.resolveMx(...a);
    export const resolve4 = async () => ["192.0.2.1"]; export const resolve6 = async () => [];`,
  "@/lib/env": `export const env = { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:44321", NEXT_PUBLIC_SITE_URL: "http://site.invalid" };`,
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
  restoreFails = undefined;
  restoreAnswer = true;
  isMember = false;
  mxAnswer = "mail";
  entered.length = 0;
  gate = Promise.resolve();
  memberAsked = [];
  mxAsked = 0;
  groupAsked = 0;
  updates.length = 0;
  updateAnswer = undefined;
  updateFails = undefined;
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

// RF-150 / RF-152. The member check and the DNS check both run before the roster write and before
// Auth is asked; a refusal writes nothing and sends nothing. `persona@example.com` is not exempt on
// the stub's local URL, so the resolver double answers for it.
const SINGLE = [
  ["createMemberAction", (a: Awaited<ReturnType<typeof actions>>, email: string) => a.createMemberAction({ name: "Ana", email })],
  ["inviteMemberByEmailAction", (a: Awaited<ReturnType<typeof actions>>, email: string) => a.inviteMemberByEmailAction({ email })],
] as const;

for (const [name, run] of SINGLE) {
  // Mutation: drop the member check.
  test(`${name}: a live member's address is refused as already in the group, with no row and no mail`, async () => {
    isMember = true;
    const result = await run(await actions(), EMAIL);
    assert.equal(result?.serverError, "members.errors.alreadyMember");
    assert.equal(result?.data, undefined);
    assert.deepEqual(memberAsked, [EMAIL], "the member check is asked the address as typed");
    assert.equal(created.length, 0);
    assert.equal(invited.length, 0);
  });

  // Mutation: check deliverability before membership.
  test(`${name}: a live member on an undeliverable domain is told they are a member`, async () => {
    isMember = true;
    mxAnswer = "nullMx";
    const result = await run(await actions(), EMAIL);
    assert.equal(result?.serverError, "members.errors.alreadyMember");
  });

  // Mutation: drop the DNS call.
  test(`${name}: a domain that takes no mail is refused as undeliverable, with no row and no mail`, async () => {
    mxAnswer = "nullMx";
    const result = await run(await actions(), EMAIL);
    assert.equal(result?.serverError, "errors.domainUndeliverable");
    assert.equal(result?.data, undefined);
    assert.equal(created.length, 0);
    assert.equal(invited.length, 0);
  });

  // Mutation: refuse on a lookup failure.
  test(`${name}: a resolver that fails does not refuse the address`, async () => {
    mxAnswer = "servfail";
    const result = await run(await actions(), EMAIL);
    assert.equal(result?.serverError, undefined);
    assert.equal(created.length, 1);
    assert.equal(invited.length, 1);
  });

  // Mutation: drop the exemption; or exempt every domain.
  test(`${name}: a .invalid address on the local stack is created without asking DNS`, async () => {
    mxAnswer = "nullMx";
    const result = await run(await actions(), "persona@mail.example.invalid");
    assert.equal(result?.serverError, undefined);
    assert.equal(created.length, 1);
    assert.equal(mxAsked, 0, "the exemption answers before the resolver");
  });

  // Mutation: chain the awaits.
  test(`${name}: the fund, the member check and DNS are asked together, before any answers`, async () => {
    let open!: () => void;
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const pending = run(await actions(), EMAIL);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const seen = [...entered].sort();
    open();
    await pending;
    assert.deepEqual(seen, ["dns", "group", "member"]);
  });
}

// Mutation: run the member check and DNS for a member with no address.
test("a member with no address is not checked for membership or deliverability", async () => {
  mxAnswer = "nullMx";
  isMember = true;
  const { createMemberAction } = await actions();
  const result = await createMemberAction({ name: "Ana" });
  assert.equal(result?.serverError, undefined);
  assert.equal(created.length, 1);
  assert.equal(memberAsked.length, 0);
  assert.equal(mxAsked, 0);
});

// Mutation: ask the member check before the fund is known, or let the fund's refusal wait for it.
test("a caller with no fund is told not found, not undeliverable", async () => {
  mxAnswer = "nullMx";
  const original = double.group;
  double.group = async () => null as never;
  try {
    const { createMemberAction } = await actions();
    const result = await createMemberAction({ name: "Ana", email: EMAIL });
    assert.equal(result?.serverError, "errors.notFound");
    assert.equal(created.length, 0);
  } finally {
    double.group = original;
  }
});

// RF-149. Postgres names the constraint on the driver error under drizzle's `.cause`.
function pgConstraintError(code: string, constraint: string) {
  return Object.assign(new Error("Failed query"), {
    cause: Object.assign(new Error("pg"), { code, constraint_name: constraint }),
  });
}

// Mutation: leave the 23505 unmapped.
test("restoring an invitation whose address a newer one holds is refused by name", async () => {
  restoreFails = pgConstraintError("23505", "group_members_group_invite_email_unique");
  const { restoreMemberAction } = await actions();
  const result = await restoreMemberAction({ memberId: "22222222-2222-4222-8222-222222222222" });
  assert.equal(result?.serverError, "members.errors.emailTaken");
});

// Mutation: map every 23505 on a restore.
test("any other unique violation on a restore is not the emailTaken refusal", async () => {
  restoreFails = pgConstraintError("23505", "group_members_one_live_membership_per_user");
  const { restoreMemberAction } = await actions();
  const result = await restoreMemberAction({ memberId: "22222222-2222-4222-8222-222222222222" });
  assert.notEqual(result?.serverError, "members.errors.emailTaken");
  assert.notEqual(result?.serverError, undefined);
});

// Mutation: map a 23505 with no constraint name.
test("a unique violation that names no constraint is not the emailTaken refusal on a restore", async () => {
  restoreFails = pgError("23505");
  const { restoreMemberAction } = await actions();
  const result = await restoreMemberAction({ memberId: "22222222-2222-4222-8222-222222222222" });
  assert.notEqual(result?.serverError, "members.errors.emailTaken");
});

// Mutation: swallow the zero-row answer.
test("a restore that changes no row is still the not-leader refusal", async () => {
  restoreAnswer = false;
  const { restoreMemberAction } = await actions();
  const result = await restoreMemberAction({ memberId: "22222222-2222-4222-8222-222222222222" });
  assert.equal(result?.serverError, "errors.notLeader");
});

// RF-153. The edit that gives a placeholder an address runs the create path's guards and sends the same
// invitation. `updateMember` is doubled: with an address it answers a status, without one a boolean.
const MEMBER = "22222222-2222-4222-8222-222222222222";
type EditResult = {
  data?: { inviteEmailFailed: boolean };
  serverError?: string;
  validationErrors?: { fieldErrors?: { email?: string[] } };
};
const edit = async (input: { name?: string; email?: string }) =>
  (await (await actions()).updateMemberAction({ memberId: MEMBER, name: "Abuela", ...input })) as EditResult | undefined;

// Mutation: ignore the address in the schema (today's), or send it without the redirect.
test("an edit with an address stores it through updateMember and asks Auth for one invitation", async () => {
  const result = await edit({ email: `  ${EMAIL} ` });
  assert.equal(result?.serverError, undefined);
  assert.deepEqual(result?.data, { inviteEmailFailed: false });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].memberId, MEMBER);
  assert.equal(updates[0].name, "Abuela");
  assert.equal(updates[0].groupId, "group-1");
  assert.equal(updates[0].inviteEmail, EMAIL, "trimmed address reaches the query");
  assert.deepEqual(invited, [[EMAIL, { redirectTo: "http://site.invalid/login" }]]);
  assert.equal(otpCalls.length, 0);
});

// Mutation: send an empty string as an address; or run the member and DNS checks without one.
test("an edit with no address, or a blank one, renames only: no address to the query, no check, no invitation", async () => {
  mxAnswer = "nullMx";
  isMember = true;
  for (const input of [{}, { email: "   " }]) {
    const result = await edit(input);
    assert.equal(result?.serverError, undefined);
    assert.equal(result?.data?.inviteEmailFailed ?? false, false);
  }
  assert.equal(updates.length, 2);
  for (const call of updates) assert.equal(call.inviteEmail, undefined);
  assert.equal(memberAsked.length, 0);
  assert.equal(mxAsked, 0);
  assert.equal(invited.length, 0);
});

// Mutation: raise on a missing admin client; or roll the stored address back.
test("an edit whose invitation cannot leave keeps the address and raises the notice", async () => {
  admin = "none";
  const none = await edit({ email: EMAIL });
  assert.equal(none?.serverError, undefined);
  assert.equal(none?.data?.inviteEmailFailed, true);
  admin = "client";
  inviteAnswer = { data: { user: null }, error: { message: "boom", status: 500 } };
  const failed = await edit({ email: EMAIL });
  assert.equal(failed?.data?.inviteEmailFailed, true);
  assert.equal(updates.length, 2, "both addresses were stored");
  assert.equal(otpCalls.length, 0);
});

// Mutation: skip the member check on update.
test("an edit giving a live member's address is refused as already in the group, with nothing written or sent", async () => {
  isMember = true;
  const result = await edit({ email: EMAIL });
  assert.equal(result?.serverError, "members.errors.alreadyMember");
  assert.equal(result?.data, undefined);
  assert.equal(updates.length, 0);
  assert.equal(invited.length, 0);
});

// Mutation: skip the DNS call on update.
test("an edit giving an address whose domain takes no mail is refused, with nothing written or sent", async () => {
  mxAnswer = "nullMx";
  const result = await edit({ email: EMAIL });
  assert.equal(result?.serverError, "errors.domainUndeliverable");
  assert.equal(updates.length, 0);
  assert.equal(invited.length, 0);
});

// Mutation: check deliverability before membership on update.
test("an edit giving a live member's address on an undeliverable domain says member", async () => {
  isMember = true;
  mxAnswer = "nullMx";
  const result = await edit({ email: EMAIL });
  assert.equal(result?.serverError, "members.errors.alreadyMember");
});

// Mutation: chain the awaits; or resolve the fund without the fan-out.
test("an edit with an address asks the fund, the member check and DNS together, before any answers", async () => {
  let open!: () => void;
  gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const pending = edit({ email: EMAIL });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const seen = [...entered].sort();
  open();
  await pending;
  assert.deepEqual(seen, ["dns", "group", "member"]);
});

// Mutation: ask the member check before the fund is known.
test("an edit by a caller with no fund is told not found, not undeliverable", async () => {
  mxAnswer = "nullMx";
  const original = double.group;
  double.group = async () => null as never;
  try {
    const result = await edit({ email: EMAIL });
    assert.equal(result?.serverError, "errors.notFound");
    assert.equal(updates.length, 0);
    assert.equal(invited.length, 0);
  } finally {
    double.group = original;
  }
});

// Mutation: map a status to the wrong key, or let a refusal send the mail.
for (const [status, key] of [
  ["notLeader", "errors.notLeader"],
  ["gone", "errors.notFound"],
  ["hasUser", "members.errors.alreadyMember"],
  ["hasInvite", "members.errors.emailTaken"],
] as const) {
  test(`updateMember answering ${status} is refused as ${key}, with no invitation`, async () => {
    updateAnswer = status;
    const result = await edit({ email: EMAIL });
    assert.equal(result?.serverError, key);
    assert.equal(result?.data, undefined);
    assert.equal(invited.length, 0);
    assert.equal(otpCalls.length, 0);
  });
}

// Mutation: leave the 23505 unmapped on update.
test("a unique violation on the edit is refused as emailTaken, with no invitation", async () => {
  updateFails = pgError("23505");
  const result = await edit({ email: EMAIL });
  assert.equal(result?.serverError, "members.errors.emailTaken");
  assert.equal(invited.length, 0);
});

// Mutation: map every database error to emailTaken on update.
test("any other database error on the edit is not the emailTaken refusal", async () => {
  updateFails = pgError("23514");
  const result = await edit({ email: EMAIL });
  assert.notEqual(result?.serverError, "members.errors.emailTaken");
  assert.notEqual(result?.serverError, undefined);
  assert.equal(invited.length, 0);
});

// Mutation: trust a falsy answer as success without an address.
test("a rename that changes no row is still the not-leader refusal", async () => {
  updateAnswer = false;
  const result = await edit({});
  assert.equal(result?.serverError, "errors.notLeader");
});

// Mutation: a second schema for the form.
test("updateMemberSchema reads a blank address as none, trims a real one and names a malformed one", () => {
  const base = { memberId: MEMBER, name: "Abuela" };
  const blank = updateMemberSchema.safeParse({ ...base, email: " " });
  assert.equal(blank.success, true);
  assert.equal((blank.data as { email?: string }).email, undefined);
  const real = updateMemberSchema.safeParse({ ...base, email: `  ${EMAIL} ` });
  assert.equal((real.data as { email?: string } | undefined)?.email, EMAIL);
  const bad = updateMemberSchema.safeParse({ ...base, email: "x" });
  assert.equal(bad.success, false);
  assert.equal(bad.error?.issues[0].message, "members.errors.emailInvalid");
});

// Mutation: validate the action with a looser schema than the form's.
test("an edit with a malformed address is refused by the schema and reaches nothing", async () => {
  const result = await edit({ email: "x" });
  assert.equal(result?.validationErrors?.fieldErrors?.email?.[0], "members.errors.emailInvalid");
  assert.equal(updates.length, 0);
  assert.equal(invited.length, 0);
});
