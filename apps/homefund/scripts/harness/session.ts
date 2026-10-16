// An authentic Supabase session for the harness, and the cookie the app reads it
// from. Nothing here is a stub: the access token is signed by the project, so the
// proxy, `requireUser()` and every access policy see a real `auth.uid()`.
//
// NOTHING HERE ASKS THE AUTH SERVER TO SEND. The addresses are synthetic and
// undeliverable, and `POST /auth/v1/otp` against one still hands the message to
// the project's SMTP, whose bounce lands in a real person's inbox. That endpoint
// is not called from this file, and adding it back would put mail on someone's
// phone once per run. A session comes from the stored refresh token; a mint
// consumes an `auth.one_time_tokens` row that is already waiting, and refuses
// rather than requesting one.
//
// THE CACHE IS NOT AN OPTIMISATION EITHER. The stored session is the only way
// back in: every run refreshes it, and a lost file cannot be replaced without a
// token row landed by hand. Pruning the sessions a refresh superseded needs no
// call either: the one to keep is named by a claim already inside the token
// this run holds, decoded locally, and the rest are dropped by a plain delete
// over the connection this file already opens.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { assertSuiteDatabase, registerSharedIdentity } from "@repo/harness-registry";
import type postgres from "postgres";

import { fixtureSql } from "./fixtures";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

// The project ref is the first hostname label of the project URL, and the cookie
// `@supabase/ssr` writes is named after it.
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split(".")[0];
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`;

// `@supabase/ssr`'s own threshold: one cookie until the encoded value passes it,
// then `${name}.0`, `${name}.1`, … over the same string.
const MAX_CHUNK_SIZE = 3180;

/**
 * The lane this run owns, read from `HARNESS_LANE`. Two tracks that set different
 * lanes share no identity, no file and no row, so their suites can run at the
 * same time. Unset and `1` are the same lane, and its names predate the lanes:
 * every stored session in `private/` hangs off them.
 */
function laneSuffix(): string {
  const lane = process.env.HARNESS_LANE?.trim() ?? "";
  if (lane === "" || lane === "1") return "";
  if (!/^[1-9][0-9]*$/.test(lane)) {
    throw new Error(`HARNESS_LANE must be a positive integer, not "${lane}"`);
  }

  return `-${lane}`;
}

export const HARNESS_LANE_SUFFIX = laneSuffix();

export const HARNESS_EMAIL = `harness${HARNESS_LANE_SUFFIX}@example.invalid`;

// The second identity: a plain member of a group it does not lead, which is the
// other half of what RF-100 separates. Kept apart from the first because a
// membership is exclusive (RF-55) — one user cannot hold both roles.
export const HARNESS_MEMBER_EMAIL = `harness-member${HARNESS_LANE_SUFFIX}@example.invalid`;

// Gitignored, and shared with layer 3 — a browser run and an HTTP run in the same
// hour cost one mint between them. One file per identity, named after the local
// part past `harness`, so lane 1 keeps the files it has always used and lane n
// carries its number through into every name.
export function sessionFileName(email: string): string {
  const suffix = email.split("@")[0].replace(/^harness/, "");

  // A refresh token is only good against the auth server that minted it, so the
  // local stack keeps files of its own and the remote's survive a local run.
  const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname;
  const local = host === "127.0.0.1" || host === "localhost" ? ".local" : "";

  return `private/harness-session${suffix}${local}.json`;
}

function sessionFile(email: string): string {
  return resolve(process.cwd(), sessionFileName(email));
}

export const HARNESS_BASE_URL =
  process.env.HARNESS_BASE_URL ?? "http://localhost:3000";

export type HarnessSession = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  token_type: "bearer";
  user: { id: string; email: string } & Record<string, unknown>;
};

const current = new Map<string, HarnessSession>();

/**
 * One identity's session for this run: the stored one refreshed, or a freshly
 * minted one. Memoised per address, so a screen's worth of requests costs no
 * round trip to the auth server.
 */
export async function harnessSession(
  email: string = HARNESS_EMAIL,
): Promise<HarnessSession> {
  const memoised = current.get(email);
  if (memoised) return memoised;

  const file = sessionFile(email);
  const stored = readStored(file);
  // A file left by another identity is not this one's session.
  const refreshed =
    stored && stored.user?.email === email
      ? await refreshSession(stored.refresh_token)
      : null;

  const session = refreshed ?? (await mintSession(email));
  current.set(email, session);
  // `private/` is gitignored, so a fresh clone reaches this write without it.
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`, "utf8");

  // Once per process per address: a later call returns the memoised session
  // above and never reaches here. `ensureHarnessAuthUser` runs even on a
  // refresh, which never reaches it on its own path through `mintSession` —
  // without this, a lane whose cache still refreshes would never register.
  await ensureHarnessAuthUser(email);
  await pruneSupersededSessions(email);

  return session;
}

// Whether this process spent a waiting token row, which is what the transcript
// reports to say a run reused its cached session.
let minted = false;

export function mintedThisRun(): boolean {
  return minted;
}

export async function harnessUserId(
  email: string = HARNESS_EMAIL,
): Promise<string> {
  return (await harnessSession(email)).user.id;
}

// The `session_id` claim out of a JWT's middle segment, read by
// base64url-decoding the payload — never verified, because this file trusts no
// claim for a decision, only for naming the row a delete must spare.
function sessionIdClaim(accessToken: string): string {
  const payload = accessToken.split(".")[1];
  if (!payload) {
    throw new Error("access token carries no payload segment to decode");
  }

  const claims = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as { session_id?: string };
  if (!claims.session_id) {
    throw new Error("access token payload carries no session_id claim");
  }

  return claims.session_id;
}

/**
 * Every `auth.sessions` row this identity holds except the one backing the
 * token just cached, and the refresh tokens that ride their cascade
 * (`refresh_tokens_session_id_fkey`, `ON DELETE CASCADE`). The session to keep
 * is named by the `session_id` claim, read by base64-decoding the access
 * token's payload locally. Bounded to `user_id` of this identity and further to
 * identities `harness.identities` holds, so this reaches no other row in
 * `auth` — a session outside the registry is never a candidate.
 */
export async function pruneSupersededSessions(email: string): Promise<number> {
  const session = current.get(email);
  if (!session) {
    throw new Error(
      `pruneSupersededSessions(${email}): no session in hand — call harnessSession first`,
    );
  }

  const userId = session.user.id;
  const keep = sessionIdClaim(session.access_token);

  const dropped = await fixtureSql`
    delete from auth.sessions
    where user_id = ${userId}
      and id != ${keep}
      and user_id in (select user_id from harness.identities)`;

  const [{ count }] = await fixtureSql<{ count: string }[]>`
    select count(*)::int as count from auth.sessions where user_id = ${userId}`;

  console.log(
    `REPORT  pruneSupersededSessions — ${email}: dropped ${dropped.count}, ${count} session(s) remain.`,
  );

  return dropped.count;
}

/**
 * The session as `@supabase/ssr` writes it: one cookie over the base64 of the
 * session JSON, split only past `MAX_CHUNK_SIZE`. A browser handed these is
 * signed in — the app reads the same cookie a real sign-in would have left, and
 * no mail is sent to get there.
 */
export async function sessionCookies(
  email: string = HARNESS_EMAIL,
): Promise<{ name: string; value: string }[]> {
  const session = await harnessSession(email);
  const encoded = `base64-${Buffer.from(JSON.stringify(session), "utf8").toString("base64")}`;

  if (encoded.length <= MAX_CHUNK_SIZE) {
    return [{ name: COOKIE_NAME, value: encoded }];
  }

  const chunks: string[] = [];
  for (let at = 0; at < encoded.length; at += MAX_CHUNK_SIZE) {
    chunks.push(encoded.slice(at, at + MAX_CHUNK_SIZE));
  }

  return chunks.map((value, index) => ({
    name: `${COOKIE_NAME}.${index}`,
    value,
  }));
}

// The same cookies on one line, which is what layer 2 sends.
export async function cookieHeader(
  email: string = HARNESS_EMAIL,
): Promise<string> {
  const cookies = await sessionCookies(email);

  return cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}

function readStored(file: string): HarnessSession | null {
  if (!existsSync(file)) return null;

  try {
    return JSON.parse(readFileSync(file, "utf8")) as HarnessSession;
  } catch {
    return null;
  }
}

async function refreshSession(
  refreshToken: string,
): Promise<HarnessSession | null> {
  const response = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
  );
  if (!response.ok) return null;

  const body = (await response.json()) as Partial<HarnessSession>;
  if (!body.access_token || !body.refresh_token || !body.user) return null;

  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_in: body.expires_in ?? 3600,
    expires_at: body.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: body.user,
  };
}

async function mintSession(email: string): Promise<HarnessSession> {
  const userId = await ensureHarnessAuthUser(email);
  const hash = await newestTokenHash(userId);
  // Requesting one is what would send the mail, so the run stops here instead.
  if (!hash) {
    throw new Error(
      `no unconsumed auth.one_time_tokens row for ${email}: restore ${sessionFile(email)} or land a token row by hand. The harness never asks the auth server for one — the address is undeliverable and the bounce reaches a real mailbox.`,
    );
  }
  minted = true;

  // 303, with the tokens in the URL fragment rather than the query.
  const verified = await fetch(
    `${SUPABASE_URL}/auth/v1/verify?type=magiclink&token=${hash}`,
    { method: "GET", redirect: "manual" },
  );
  const fragment = new URLSearchParams(
    (verified.headers.get("location") ?? "").split("#")[1] ?? "",
  );
  const accessToken = fragment.get("access_token");
  const refreshToken = fragment.get("refresh_token");
  if (!accessToken || !refreshToken) {
    throw new Error(
      `magic link verification answered ${verified.status} without tokens`,
    );
  }

  // The session JSON carries the user the app's client expects to find in it.
  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!userResponse.ok) {
    throw new Error(`GET /auth/v1/user answered ${userResponse.status}`);
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: Number(fragment.get("expires_in") ?? 3600),
    expires_at: Number(fragment.get("expires_at") ?? 0),
    token_type: "bearer",
    user: (await userResponse.json()) as HarnessSession["user"],
  };
}

// Over the direct connection, because no API hands a token hash back. Old rows
// are skipped: a magic link outlives its usefulness long before it expires.
async function newestTokenHash(userId: string): Promise<string | null> {
  const [row] = await fixtureSql<{ token_hash: string }[]>`
    select token_hash
    from auth.one_time_tokens
    where user_id = ${userId}
      and created_at > now() - interval '30 minutes'
    order by created_at desc
    limit 1`;

  return row?.token_hash ?? null;
}

/**
 * A harness identity, created once and never dropped — the cached session is
 * worthless against a user that a cleanup removed. Every column GoTrue scans is
 * filled; the nulls it cannot read are what the 500 above came from.
 *
 * Registers the identity `shared` either way: an existing row lands in
 * `harness.identities` on this call alone (`on conflict do nothing`, so lanes
 * 1–7 and 9 enter the registry on their next run with no migration), and a
 * fresh row is registered inside the same transaction as its `auth.users`
 * insert, so no crash between the two can leave one without the other.
 */
export async function ensureHarnessAuthUser(email: string): Promise<string> {
  assertSuiteDatabase();
  const [existing] = await fixtureSql<{ id: string }[]>`
    select id from auth.users where email = ${email}`;
  if (existing) {
    await registerSharedIdentity(fixtureSql, { id: existing.id, email });
    return existing.id;
  }

  const id = randomUUID();

  await fixtureSql.begin(async (tx) => {
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
    await tx`insert into app_users (id, locale) values (${id}, 'es')`;
    // `TransactionSql` lacks the pool-only members of `Sql` (`end`, `close`, …)
    // that `registerSharedIdentity` never calls; the cast asks for none of them.
    await registerSharedIdentity(tx as unknown as postgres.Sql, { id, email });
  });

  return id;
}
