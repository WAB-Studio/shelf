import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

// RF-154. The real `landSession` runs; the database, cookies and the membership functions are doubled at
// module resolution. Signing in joins nothing, so every membership function is a spy that must stay
// uncalled, and the claim the old landing ran answers "claimed" to make a call visible in the target too.

const USER = { id: "00000000-0000-4000-8000-000000000154", email: "invitada@example.com" };
const membershipCalls: string[] = [];
const rawStatements: unknown[] = [];
const deleted: string[] = [];
let locale = "es";
let postLogin: string | undefined;

const double = {
  cookies: async () => ({
    get: (name: string) => (name === "post_login_redirect" && postLogin ? { value: postLogin } : undefined),
    delete: (name: string) => deleted.push(name),
  }),
  withUserDb: async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ locale }] }) }) }),
      execute: async (statement: unknown) => {
        rawStatements.push(statement);
        return [{ id: "00000000-0000-4000-8000-0000000000aa" }];
      },
    }),
  spy: (name: string, answer: unknown) => async () => {
    membershipCalls.push(name);
    return answer;
  },
};
(globalThis as unknown as { __landDouble: typeof double }).__landDouble = double;
const D = "globalThis.__landDouble";

const DOUBLES: Record<string, string> = {
  "server-only": "export {};",
  "next/headers": `export const cookies = () => ${D}.cookies();`,
  "drizzle-orm": "export const eq = () => ({});",
  "@/db/insert-row": `export const insertRow = async () => [{ id: "created" }];`,
  "@/db/queries/personal-space": "export const seedPersonalCategories = async () => {};",
  "@/db/schema": "export const appUsers = { id: {}, locale: {} };",
  "@/db/session": `export const withUserDb = (...a) => ${D}.withUserDb(...a);`,
  "@/db/queries/group-members": `
    export const claimInviteForUser = ${D}.spy("claimInviteForUser", "claimed");
    export const acceptInvitation = ${D}.spy("acceptInvitation", "accepted");
    export const declineInvitation = ${D}.spy("declineInvitation", "declined");
    export const leaveFund = ${D}.spy("leaveFund", "left");`,
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

async function land() {
  const { landSession } = await import("./land-session");
  return landSession({ user: USER, fallbackLocale: "es" });
}

beforeEach(() => {
  membershipCalls.length = 0;
  rawStatements.length = 0;
  deleted.length = 0;
  locale = "es";
  postLogin = undefined;
});

test("signing in with a pending invitation joins nobody: no membership function runs and the person lands on the home page", async () => {
  for (const landed of ["es", "en"]) {
    locale = landed;
    membershipCalls.length = 0;
    const result = await land();
    assert.deepEqual(membershipCalls, [], "a membership function ran at sign-in");
    assert.equal(result.target, `/${landed}`);
    assert.equal(result.locale, landed);
  }
});

test("landing runs no statement of its own beyond the user's row: nothing raw reaches the database", async () => {
  await land();
  assert.deepEqual(rawStatements, []);
});

test("the page asked for before signing in is where the person lands, and the cookie is spent", async () => {
  postLogin = "/es/movements";
  const result = await land();
  assert.equal(result.target, "/es/movements");
  assert.deepEqual(deleted, ["post_login_redirect"]);
  assert.deepEqual(membershipCalls, []);
});

test("a post-login address that leaves the app is never followed: the person lands on the home page and the cookie is spent", async () => {
  for (const external of ["https://other.example/x", "//other.example", "/\\other.example", "javascript:alert(1)", "other.example"]) {
    postLogin = external;
    deleted.length = 0;
    const result = await land();
    assert.equal(result.target, "/es", `followed ${external}`);
    assert.deepEqual(deleted, ["post_login_redirect"]);
  }
});
