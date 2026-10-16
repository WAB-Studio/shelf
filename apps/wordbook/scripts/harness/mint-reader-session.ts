// Mints a real voyager reader session for a script or a check to drive, so
// RL-01's "an authenticated request sees its own rows" no longer has to be
// proved by reading `lib/session.ts` — it can be driven over HTTP instead.
//
// Voyager has no Admin API key (`lib/env.ts`) and none is added here: a
// service-role key in the harness is a production key in the harness. The
// path that works instead is the one `apps/homefund/scripts/harness/
// mint-harness-token.ts` already proved: land a row in
// `auth.one_time_tokens` over a direct connection, then let voyager's own
// `GET /auth/confirm` verify it — the same route a real magic link lands on.
// GoTrue checks `type=magiclink` against `auth.users.recovery_token`, so the
// landed row and the column carry the same hash.
//
// The two apps share one Supabase project, so `harness.runs` and
// `harness.identities` — schemas `apps/homefund/db/migrations/0039` owns — are
// reachable from here over the same `MIGRATION_DATABASE_URL`. `openRun` and
// `closeRun` come from `@repo/harness-registry`, the package both apps
// depend on, rather than reimplemented, so `npm run harness:census -w
// apps/homefund` sees this identity the moment it lands.
// `registerEphemeralIdentity` itself is not imported: it inserts into
// `app_users`, a finances table a voyager reader never has a row in — the
// run and the `harness.identities` insert are composed here instead, by
// hand, without it.
import { randomBytes, randomUUID } from "node:crypto";

import { closeRun, openRun } from "@repo/harness-registry";
import postgres from "postgres";

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, {
  prepare: false,
  max: 1,
});

function laneNumber(): number {
  const raw = process.env.HARNESS_LANE?.trim();
  if (!raw) return 1;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`HARNESS_LANE must be a positive integer, not "${raw}"`);
  }
  return Number(raw);
}

// `apps/<app>` on `:3<a>0<n-1>`. Overridable for a lane pointed at someone
// else's already-running server (`docs/agentes/lanes.md`, "Harness lanes").
function baseUrl(): string {
  return process.env.HARNESS_BASE_URL ?? `http://localhost:${3100 + laneNumber() - 1}`;
}

/**
 * A fresh `auth.users` row and its `harness.identities` row, landed in one
 * transaction so a crash between the two never leaves either without the
 * other. Every column GoTrue's own verify path reads is filled — the same
 * set `ensureHarnessAuthUser` (`apps/homefund/scripts/harness/session.ts`)
 * fills — because a null one there is a 500, not a refusal.
 */
async function createReaderIdentity(runId: string): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `harness-reader-${id}@example.invalid`;

  await sql.begin(async (tx) => {
    await tx`
      insert into auth.users (
        id, instance_id, aud, role, email, email_confirmed_at,
        encrypted_password, confirmation_token, recovery_token,
        email_change, email_change_token_current, email_change_token_new,
        email_change_confirm_status, phone_change, phone_change_token,
        reauthentication_token, raw_app_meta_data, raw_user_meta_data,
        is_sso_user, is_anonymous, created_at, updated_at)
      values (
        ${id}, '00000000-0000-0000-0000-000000000000', 'authenticated',
        'authenticated', ${email}, now(),
        '', '', '',
        '', '', '',
        0, '', '',
        '', '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
        false, false, now(), now())`;

    await tx`
      insert into harness.identities (user_id, run_id, email, disposition)
      values (${id}, ${runId}, ${email}, 'ephemeral')`;
  });

  return { id, email };
}

// Same technique as `mint-harness-token.ts`'s `land`: a fresh hash in both
// `auth.users.recovery_token` and a matching `auth.one_time_tokens` row,
// which is the only pair GoTrue's `verifyOtp` will accept.
async function landRecoveryToken(userId: string, email: string): Promise<string> {
  const hash = randomBytes(32).toString("hex");

  await sql`
    update auth.users
    set recovery_token = ${hash}, recovery_sent_at = now(), updated_at = now()
    where id = ${userId}`;

  await sql`
    insert into auth.one_time_tokens
      (id, user_id, token_type, token_hash, relates_to, created_at, updated_at)
    values
      (${randomUUID()}, ${userId}, 'recovery_token', ${hash}, ${email}, now(), now())`;

  return hash;
}

/**
 * The real route, by HTTP: `GET /auth/confirm?token_hash=…&type=magiclink`.
 * `redirect: "manual"` is what lets `mintSession` (`session.ts`) read a
 * redirect's headers instead of following it — the same trick works here for
 * `Set-Cookie`, which a followed redirect would otherwise consume before this
 * script ever saw it.
 */
async function mintSessionCookie(hash: string): Promise<string> {
  const response = await fetch(
    `${baseUrl()}/auth/confirm?token_hash=${hash}&type=magiclink`,
    { redirect: "manual" },
  );

  const location = response.headers.get("location");
  if (location?.includes("error=")) {
    throw new Error(`GET /auth/confirm redirected to ${location} — link was refused`);
  }

  const cookies = response.headers.getSetCookie();
  if (cookies.length === 0) {
    throw new Error(`GET /auth/confirm answered ${response.status} with no Set-Cookie header`);
  }

  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function fetchDevices(cookie: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl()}/api/devices`, { headers: { cookie } });
  return { status: response.status, body: await response.json().catch(() => null) };
}

// Undoes `createReaderIdentity` and `landRecoveryToken`. `auth.users`
// cascades to `auth.sessions`, `auth.refresh_tokens`, `auth.one_time_tokens`
// and — `devices.ts` / `lookups.ts`'s own `onDelete: "cascade"` — to
// `reading.devices` and `reading.lookups`, so naming it here is enough.
async function dropReaderIdentity(userId: string): Promise<void> {
  await sql`delete from harness.identities where user_id = ${userId}`;
  await sql`delete from auth.users where id = ${userId}`;
}

async function main(): Promise<void> {
  const runId = await openRun("seed", sql);
  const identity = await createReaderIdentity(runId);

  try {
    const hash = await landRecoveryToken(identity.id, identity.email);
    const cookie = await mintSessionCookie(hash);
    const { status, body } = await fetchDevices(cookie);

    console.log(`minted a session for ${identity.email} (${identity.id})`);
    console.log(`GET /api/devices -> ${status} ${JSON.stringify(body)}`);

    if (status !== 200) {
      throw new Error(`GET /api/devices answered ${status}, expected 200`);
    }
  } finally {
    await dropReaderIdentity(identity.id);
    await closeRun(sql);
    console.log(`dropped ${identity.email} (${identity.id})`);
  }
}

void (async () => {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    console.error(`FAILED  ${(error as Error).message}`);
    process.exit(1);
  } finally {
    await sql.end();
  }
})();
