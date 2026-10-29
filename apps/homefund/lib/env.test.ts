import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

// RF-143's default ceilings and RF-148's secret key, read from the real `lib/env.ts`.
// Each case loads the module afresh, because `createEnv` validates once at load.

const REQUIRED = {
  DATABASE_URL: "postgresql://u:p@localhost:6543/db",
  MIGRATION_DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  CRON_SECRET: "0123456789abcdef-secret",
  NEXT_PUBLIC_SUPABASE_URL: "http://localhost:44321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
};
const VARIABLES = [
  ...Object.keys(REQUIRED),
  "SIGN_IN_LINK_DAILY_CLIENT_CAP",
  "SIGN_IN_LINK_DAILY_ADDRESS_CAP",
  "SUPABASE_SECRET_KEY",
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

// Mutation: leave `default(5)`.
test("a caller is capped at 10 sign-in links a day when no cap is set", async () => {
  const { env } = await load();
  assert.equal(env.SIGN_IN_LINK_DAILY_CLIENT_CAP, 10);
});

// Mutation: raise both defaults.
test("an address is capped at 3 sign-in links a day when no cap is set", async () => {
  const { env } = await load();
  assert.equal(env.SIGN_IN_LINK_DAILY_ADDRESS_CAP, 3);
});

// Mutation (cb2-18): drop `.optional()`.
test("a deploy without the secret key boots, with the key undefined", async () => {
  const { env } = await load();
  assert.equal(env.SUPABASE_SECRET_KEY, undefined);
});

// Mutation (cb2-17): drop `.startsWith("sb_secret_")`.
test("a publishable key is refused as the secret key", async () => {
  await assert.rejects(load({ SUPABASE_SECRET_KEY: "sb_publishable_x" }), /Invalid environment variables/);
});

test("a legacy JWT is refused as the secret key", async () => {
  await assert.rejects(load({ SUPABASE_SECRET_KEY: "eyJhbGciOiJIUzI1NiJ9.e30.sig" }), /Invalid environment variables/);
});

// Mutation: prefix `sb_publishable_`.
test("a secret key is accepted and kept", async () => {
  const { env } = await load({ SUPABASE_SECRET_KEY: "sb_secret_x" });
  assert.equal(env.SUPABASE_SECRET_KEY, "sb_secret_x");
});

// Mutation: `.nonnegative()` in place of `.positive()` on a cap lets 0 through; dropping `.int()` lets 2.5 through.
for (const name of ["SIGN_IN_LINK_DAILY_CLIENT_CAP", "SIGN_IN_LINK_DAILY_ADDRESS_CAP"]) {
  test(`${name} of 0 is refused`, async () => {
    await assert.rejects(load({ [name]: "0" }), /Invalid environment variables/);
  });

  test(`${name} of 2.5 is refused`, async () => {
    await assert.rejects(load({ [name]: "2.5" }), /Invalid environment variables/);
  });

  test(`${name} of 7 is kept`, async () => {
    const { env } = await load({ [name]: "7" });
    assert.equal(env[name as "SIGN_IN_LINK_DAILY_CLIENT_CAP"], 7);
  });
}

// Mutation: `min(16)` -> `min(1)`.
test("a client key salt of 15 characters is refused", async () => {
  await assert.rejects(load({ CLIENT_KEY_SALT: "a".repeat(15) }), /Invalid environment variables/);
});

test("a client key salt of 16 characters is accepted and kept", async () => {
  const { env } = await load({ CLIENT_KEY_SALT: "a".repeat(16) });
  assert.equal(env.CLIENT_KEY_SALT, "a".repeat(16));
});

// Mutation: `emptyStringAsUndefined: false`.
test("an empty secret key boots as if unset", async () => {
  const { env } = await load({ SUPABASE_SECRET_KEY: "" });
  assert.equal(env.SUPABASE_SECRET_KEY, undefined);
});
