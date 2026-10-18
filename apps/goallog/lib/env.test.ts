import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

// RP-138: the daily caps and the salt their keys hash with, read from the real `lib/env.ts`.
// Each case loads the module afresh, because `createEnv` validates once at load.

const REQUIRED = {
  DATABASE_URL: "postgresql://u:p@localhost:6543/db",
  NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
};
const VARIABLES = [
  ...Object.keys(REQUIRED),
  "SIGN_IN_LINK_DAILY_CLIENT_CAP",
  "SIGN_IN_LINK_DAILY_ADDRESS_CAP",
  "CLIENT_KEY_SALT",
  "SKIP_ENV_VALIDATION",
];

const saved = new Map<string, string | undefined>(VARIABLES.map((key) => [key, process.env[key]]));
let loads = 0;

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function load(vars: Record<string, string> = {}) {
  for (const key of VARIABLES) delete process.env[key];
  Object.assign(process.env, REQUIRED, vars);
  loads += 1;
  return (await import(`./env.ts?case=${loads}-${Date.now()}`)) as typeof import("./env");
}

const refused = /Invalid environment variables/;

// Mutation: `default(5)`.
test("unset, a caller is capped at 10 links a day", async () => {
  const { env } = await load();
  assert.equal((env as Record<string, unknown>).SIGN_IN_LINK_DAILY_CLIENT_CAP, 10);
});

// Mutation: `default(5)` on the address cap.
test("unset, an address is capped at 3 links a day", async () => {
  const { env } = await load();
  assert.equal((env as Record<string, unknown>).SIGN_IN_LINK_DAILY_ADDRESS_CAP, 3);
});

// Mutation: drop `.optional()` or give the salt a default.
test("unset, the salt is undefined and the app still boots", async () => {
  const { env } = await load();
  assert.equal((env as Record<string, unknown>).CLIENT_KEY_SALT, undefined);
});

// Mutation: `.positive()` -> `.nonnegative()`.
for (const name of ["SIGN_IN_LINK_DAILY_CLIENT_CAP", "SIGN_IN_LINK_DAILY_ADDRESS_CAP"]) {
  test(`${name} of 0 stops the load`, async () => {
    await assert.rejects(load({ [name]: "0" }), refused);
  });

  // Mutation: drop `.int()`.
  test(`${name} of 2.5 stops the load`, async () => {
    await assert.rejects(load({ [name]: "2.5" }), refused);
  });

  test(`${name} set to 7 is read as 7`, async () => {
    const { env } = await load({ [name]: "7" });
    assert.equal((env as Record<string, unknown>)[name], 7);
  });
}

// Mutation: `min(16)` -> `min(1)`.
test("a 15-character salt stops the load", async () => {
  await assert.rejects(load({ CLIENT_KEY_SALT: "a".repeat(15) }), refused);
});

test("a 16-character salt is kept", async () => {
  const salt = "b".repeat(16);
  const { env } = await load({ CLIENT_KEY_SALT: salt });
  assert.equal((env as Record<string, unknown>).CLIENT_KEY_SALT, salt);
});

// Mutation: `emptyStringAsUndefined: false`.
test("an empty salt reads as undefined", async () => {
  const { env } = await load({ CLIENT_KEY_SALT: "" });
  assert.equal((env as Record<string, unknown>).CLIENT_KEY_SALT, undefined);
});
