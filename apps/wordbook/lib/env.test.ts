// The default ceilings decided on 2026-10-08, read from `env` with no cap variable set.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

const CAPS = [
  "WORD_TEXT_DAILY_CLIENT_CAP",
  "TRANSLATE_DAILY_CLIENT_CAP",
  "SIGN_IN_LINK_DAILY_CLIENT_CAP",
  "SIGN_IN_LINK_DAILY_ADDRESS_CAP",
] as const;

const REQUIRED = {
  DATABASE_URL: "postgresql://u:p@localhost:6543/db",
  MIGRATION_DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
};

const saved = new Map<string, string | undefined>();
let env: (typeof import("./env"))["env"];

before(async () => {
  for (const key of [...CAPS, ...Object.keys(REQUIRED)]) saved.set(key, process.env[key]);
  for (const key of CAPS) delete process.env[key];
  Object.assign(process.env, REQUIRED);
  // A unique query gives this file its own evaluation of the module.
  ({ env } = await import(`./env.ts?defaults=${Date.now()}`));
});

after(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("a call to the text route is capped at 150 a day per client", () => {
  assert.equal(env.WORD_TEXT_DAILY_CLIENT_CAP, 150);
});

test("a call to translate is capped at 300 a day per client", () => {
  assert.equal(env.TRANSLATE_DAILY_CLIENT_CAP, 300);
});

test("sign-in links are capped at 10 a day per client", () => {
  assert.equal(env.SIGN_IN_LINK_DAILY_CLIENT_CAP, 10);
});

test("sign-in links are capped at 3 a day per address", () => {
  assert.equal(env.SIGN_IN_LINK_DAILY_ADDRESS_CAP, 3);
});

// Each case loads the real module afresh with the given variables, then restores the environment.
let loads = 0;

async function load(vars: Record<string, string>) {
  const keys = [...CAPS, ...Object.keys(REQUIRED), "CLIENT_KEY_SALT", "SKIP_ENV_VALIDATION"];
  const before = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, REQUIRED, vars);
    loads += 1;
    return (await import(`./env.ts?case=${loads}-${Date.now()}`)) as typeof import("./env");
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Mutation: `.nonnegative()` in place of `.positive()` lets 0 through; dropping `.int()` lets 2.5 through.
for (const name of ["SIGN_IN_LINK_DAILY_CLIENT_CAP", "SIGN_IN_LINK_DAILY_ADDRESS_CAP"] as const) {
  test(`${name} of 0 is refused`, async () => {
    await assert.rejects(load({ [name]: "0" }), /Invalid environment variables/);
  });

  test(`${name} of 2.5 is refused`, async () => {
    await assert.rejects(load({ [name]: "2.5" }), /Invalid environment variables/);
  });

  test(`${name} of 7 is kept`, async () => {
    const loaded = await load({ [name]: "7" });
    assert.equal(loaded.env[name], 7);
  });
}
