/**
 * The one module every harness entry point calls to open a run, register an
 * identity, beat and close. Every table it writes lives in `harness`, outside
 * `public`, so none of this ever reaches `audit_log` (`db/migrations/0039`).
 *
 * `sql` is always the caller's own `postgres` client: this module opens no
 * connection of its own, and holds no client-level state but the current run.
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import type postgres from "postgres";

type Sql = postgres.Sql;

export type Suite = "e2e" | "queries" | "http" | "rls" | "seed" | "adopt";
export type Disposition = "ephemeral" | "shared";

// Mirrors orbit's `scripts/harness/session.ts`'s `laneSuffix`, not imported
// from it: `session.ts` imports `fixtureSql` from `./fixtures`, and
// `fixtures.ts` imports from this package, so importing `session.ts` here
// would close a cycle.
function harnessLane(): number {
  const raw = process.env.HARNESS_LANE?.trim();
  if (!raw) return 1;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`HARNESS_LANE must be a positive integer, not "${raw}"`);
  }

  return Number(raw);
}

// Best-effort: a worktree's branch name is a debugging aid, not a fact a run
// depends on, so a missing `git` binary or a detached head leaves the column
// null rather than failing the run.
function currentGitBranch(): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// `harness:<suite>:<lane>`. Every harness pool sets this as
// `connection.application_name`, so a live connection names the suite and the
// lane that opened it in `pg_stat_activity` without a join back to this table.
export function applicationName(suite: Suite): string {
  return `harness:${suite}:${harnessLane()}`;
}

/**
 * Stops a run that would write harness rows to a database that is not the local
 * stack, unless `HARNESS_DATABASE=remote` says that is meant (the RNF-09 timing).
 * Names the host alone: the URL carries the password.
 */
export function assertSuiteDatabase(
  url: string | undefined = process.env.MIGRATION_DATABASE_URL ??
    process.env.DATABASE_URL,
): void {
  if (process.env.HARNESS_DATABASE === "remote") return;

  let host: string | undefined;
  try {
    host = url ? new URL(url).hostname : undefined;
  } catch {
    host = undefined;
  }

  if (host === "127.0.0.1" || host === "localhost") return;

  throw new Error(
    `harness: ${host || "an unreadable database URL"} is not the local stack — run through scripts/supabase-local.sh exec, or set HARNESS_DATABASE=remote`,
  );
}

let currentRunId: string | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let closed = false;

/**
 * Inserts the run row and starts a 30 s heartbeat on an `unref()`ed interval, so
 * it never holds the process open. Idempotent per process: a second call from
 * the same process returns the id already opened and touches the database for
 * neither the insert nor a second heartbeat.
 */
export async function openRun(suite: Suite, sql: Sql): Promise<string> {
  if (currentRunId) return currentRunId;
  assertSuiteDatabase();

  const id = randomUUID();
  await sql`
    insert into harness.runs (id, lane, suite, host, pid, git_branch)
    values (
      ${id}, ${harnessLane()}, ${suite}, ${hostname()}, ${process.pid},
      ${currentGitBranch()}
    )
  `;

  currentRunId = id;
  heartbeatTimer = setInterval(() => {
    // A tagged template alone builds the query but never sends it: postgres.js's
    // `Query` only dispatches from `.then`/`.catch`/`.execute` (`node_modules/
    // postgres/cjs/src/query.js`). `.catch` both fires it and keeps one dropped
    // tick from becoming an unhandled rejection — the next tick tries again.
    sql`update harness.runs set heartbeat_at = now() where id = ${id}`.catch(() => {});
  }, 30_000);
  heartbeatTimer.unref();

  return id;
}

// The run's id: the one `openRun` opened here, else the one a parent process
// exported in HARNESS_RUN_ID (a Playwright worker never opens its own). Throws
// when neither exists. Callers never carry it by hand.
export function runId(): string {
  const inherited = process.env.HARNESS_RUN_ID?.trim();
  const id = currentRunId ?? (inherited || undefined);
  if (!id) throw new Error("openRun has not run in this process");
  return id;
}

// The columns GoTrue's own paths read: a null `instance_id`, `aud` or token
// column makes the user invisible to it or a 500 on send and verify.
function authUserRow(user: { id: string; email: string }, sql: Sql | postgres.TransactionSql) {
  return sql`
    insert into auth.users (
      id, instance_id, aud, role, email, email_confirmed_at,
      encrypted_password, confirmation_token, recovery_token,
      email_change, email_change_token_current, email_change_token_new,
      email_change_confirm_status, phone_change, phone_change_token,
      reauthentication_token, raw_app_meta_data, raw_user_meta_data,
      is_sso_user, is_anonymous, created_at, updated_at)
    values (
      ${user.id}, '00000000-0000-0000-0000-000000000000', 'authenticated',
      'authenticated', ${user.email}, now(),
      '', '', '',
      '', '', '',
      0, '', '',
      '', '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
      false, false, now(), now())
    returning id
  `;
}

/**
 * Creates an identity AND registers it in one statement: chained CTEs over
 * `auth.users`, `app_users` and `harness.identities`, so a crash between the
 * auth row and the registry row can never happen. The auth row carries the full
 * column set GoTrue needs, so a magic-link send finds the user.
 *
 * A database with no `app_users` (GoalLog's) skips that step: the relation is
 * looked up first, one cheap round trip, so no caller has to know which app it runs in.
 */
export async function registerEphemeralIdentity(
  sql: Sql,
  user: { id: string; email: string },
): Promise<void> {
  assertSuiteDatabase();
  const run = runId();

  const [{ present }] = await sql<{ present: boolean }[]>`
    select to_regclass('app_users') is not null as present
  `;

  if (!present) {
    await sql.begin(async (tx) => {
      await authUserRow(user, tx);
      await tx`
        insert into harness.identities (user_id, run_id, email, disposition)
        values (${user.id}, ${run}, ${user.email}, 'ephemeral')
      `;
    });
    return;
  }

  await sql`
    with new_auth_user as (
      ${authUserRow(user, sql)}
    ),
    new_app_user as (
      insert into app_users (id)
      select id from new_auth_user
      returning id
    )
    insert into harness.identities (user_id, run_id, email, disposition)
    select id, ${run}, ${user.email}, 'ephemeral' from new_app_user
  `;
}

// Records a lane identity as `shared` if it is not already recorded. The
// `auth.users`/`app_users` rows already exist — `session.ts` lands them once
// per lane — so this only ever touches `harness.identities`.
export async function registerSharedIdentity(
  sql: Sql,
  user: { id: string; email: string },
): Promise<void> {
  assertSuiteDatabase();
  await sql`
    insert into harness.identities (user_id, run_id, email, disposition)
    values (${user.id}, null, ${user.email}, 'shared')
    on conflict (user_id) do nothing
  `;
}

/**
 * Every `auth.users` id this run registered, by disposition. Ephemeral rows
 * carry this run's id; shared rows carry none — the check constraint on
 * `harness.identities` forces `run_id` null for them — so a shared identity
 * counts as "this run's" only once this run has called `registerSharedIdentity`
 * on it, which is why both branches below still scope to `disposition`.
 */
export async function registeredIdentities(
  sql: Sql,
  disposition?: Disposition,
): Promise<string[]> {
  const run = runId();

  const rows =
    disposition === "shared"
      ? await sql<{ user_id: string }[]>`
          select user_id from harness.identities where disposition = 'shared'
        `
      : disposition === "ephemeral"
        ? await sql<{ user_id: string }[]>`
            select user_id from harness.identities
            where run_id = ${run} and disposition = 'ephemeral'
          `
        : await sql<{ user_id: string }[]>`
            select user_id from harness.identities
            where run_id = ${run} or disposition = 'shared'
          `;

  return rows.map((row) => row.user_id);
}

/**
 * Records an OAuth client this run registered in `goals.oauth_clients`, stamped
 * with this run's id, so the run's close or a later reap can drop it by registry
 * rather than by its name or its address.
 */
export async function registerOAuthClient(sql: Sql, clientId: string): Promise<void> {
  assertSuiteDatabase();
  const run = runId();

  await sql`
    insert into harness.oauth_clients (client_id, run_id) values (${clientId}, ${run})
  `;
}

// Every OAuth client id this run registered.
export async function registeredOAuthClients(sql: Sql): Promise<string[]> {
  const run = runId();

  const rows = await sql<{ client_id: string }[]>`
    select client_id from harness.oauth_clients where run_id = ${run}
  `;

  return rows.map((row) => row.client_id);
}

// Stops the heartbeat and stamps `finished_at`. Safe to call twice: the second
// call finds `closed` already set and spends no round trip.
export async function closeRun(sql: Sql): Promise<void> {
  if (!currentRunId || closed) return;
  closed = true;

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  await sql`
    update harness.runs set finished_at = now() where id = ${currentRunId}
  `;
}
