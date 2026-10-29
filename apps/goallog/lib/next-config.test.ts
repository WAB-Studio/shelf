import assert from "node:assert/strict";
import test from "node:test";

// `next.config.ts` runs its guard at import, so each case loads a fresh copy.
async function load(env: Record<string, string | undefined>): Promise<unknown> {
  const saved = Object.keys(env).map((key) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await import(`../next.config?case=${Math.random()}`);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a Vercel build that carries the fault seam is refused", async () => {
  await assert.rejects(
    () => load({ VERCEL: "1", PULSAR_FAULT_SEAM: "reading_lookups" }),
    /PULSAR_FAULT_SEAM is set on Vercel/,
  );
});

test("the seam alone, or Vercel alone, builds", async () => {
  await load({ VERCEL: undefined, PULSAR_FAULT_SEAM: "reading_lookups" });
  await load({ VERCEL: "1", PULSAR_FAULT_SEAM: undefined });
});

const LOCAL_DB = "postgresql://postgres:postgres@127.0.0.1:44322/postgres";
const REMOTE_DB = "postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";

test("a server whose clock is pinned against a database off the local stack refuses to boot", async () => {
  await assert.rejects(
    () => load({ VERCEL: undefined, PULSAR_CLOCK: "2026-10-21", DATABASE_URL: REMOTE_DB }),
    /PULSAR_CLOCK/,
  );
  await assert.rejects(
    () => load({ VERCEL: "1", PULSAR_CLOCK: "2026-10-21", DATABASE_URL: LOCAL_DB }),
    /PULSAR_CLOCK/,
  );
});

test("a pinned clock on the local stack, or no clock on any database, boots", async () => {
  await load({ VERCEL: undefined, PULSAR_CLOCK: "2026-10-21", DATABASE_URL: LOCAL_DB });
  await load({ VERCEL: "1", PULSAR_CLOCK: undefined, DATABASE_URL: REMOTE_DB });
});
