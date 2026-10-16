// The harness user and the rows a run needs to exist before it drives the app's
// own functions. Everything here goes over a direct `postgres` connection —
// never the app pool the queries under test open — and runs as the owner, which
// holds BYPASSRLS. Fixtures are the ground; only the code under test meets RLS.
import { randomUUID } from "node:crypto";

import {
  applicationName,
  closeRun,
  openRun,
  registerEphemeralIdentity,
  registeredIdentities,
  type Suite,
} from "@repo/harness-registry";
import postgres from "postgres";
import type { Sql, TransactionSql } from "postgres";

import { TIME_ZONE } from "@/lib/locales";

// The suite this process runs as, read by `applicationName` and by the run this
// process opens. `setSuite` is the entry point's job to call before the first
// query; a process that never calls it still gets a name and a run, both under
// this default, because `createUser` cannot wait for a caller that may not come.
let currentSuite: Suite = "queries";

export function setSuite(suite: Suite): void {
  currentSuite = suite;
}

let statements = 0;

export const fixtureSql = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 1,
  connection: {
    // The tables live in `finances`; raw SQL here names them unqualified.
    search_path: "finances, public",
    // A getter, not a value: `max: 1` connects lazily on the first query, so this
    // reads `currentSuite` at that moment, after `setSuite` has had its chance —
    // not at module load, when the suite is not yet known. It never reaches
    // `pg_stat_activity` as anything but `Supavisor` (`docs/TRAPS.md`), so this is
    // for a log, never for a query.
    get application_name() {
      return applicationName(currentSuite);
    },
  },
  // Counts every statement the driver puts on the wire, the same way
  // `scripts/harness/instrument.ts` counts the app pool's — `cleanup` reads the
  // delta to report the round trips its own run spent.
  debug: () => {
    statements += 1;
  },
});

// Child before parent: `cleanup` walks this order, so a tracked row never
// outlives a row that points at it — several of these foreign keys are ON DELETE
// RESTRICT. `audit_log` is absent on purpose: the trail is append-only and the
// RNF-14 purge is its only deleter, so a harness run never removes a row from it.
const CLEANUP_ORDER = [
  ["ingest_shapes", "id"],
  ["ingest_merchants", "id"],
  ["goal_contributions", "id"],
  ["transaction_labels", "transaction_id"],
  ["transaction_splits", "transaction_id"],
  ["installment_lines", "id"],
  ["installment_plans", "id"],
  ["account_statements", "id"],
  ["debt_terms", "account_id"],
  ["budgets", "id"],
  ["planned_payments", "id"],
  ["recurring_rules", "id"],
  ["savings_goals", "id"],
  ["transactions", "id"],
  ["webhook_credentials", "id"],
  ["labels", "id"],
  ["categories", "id"],
  ["accounts", "id"],
  // The group goes before its members: `assert_group_keeps_leader` refuses to
  // leave a live group leaderless, and the cascade from a deleted group is the
  // one path that may take a leader row with it.
  ["groups", "id"],
  ["group_members", "id"],
] as const;

export type FixtureTable = (typeof CLEANUP_ORDER)[number][0];

// A year of movements, as the decision fixes it: eleven a day for 365 days. It
// is the premise RNF-09's budget is stated against, so `scripts/seed-year.ts`
// writes exactly this many and `scripts/check-http.ts` refuses to report a
// verdict until at least this many are in the ledger it measures.
export const YEAR_OF_MOVEMENTS = 4015;

// The `external_ref` every seeded movement carries, which is what makes the seed
// repeatable and its drop exact.
export const YEAR_SEED_PREFIX = "rnf09-year:";

// The movements a user owns, counted as the owner: the precondition a measurement
// of RNF-09 reads before it claims to have measured anything.
export async function countOwnedMovements(userId: string): Promise<number> {
  const [row] = await fixtureSql<{ total: string }[]>`
    select count(*)::text as total from transactions where owner_user_id = ${userId}`;

  return Number(row.total);
}

// The identity behind an email, or null. `scripts/seed-year.ts` names the user it
// seeds this way, and the timing suites name the user they read as.
export async function findUserByEmail(email: string): Promise<HarnessUser | null> {
  const [row] = await fixtureSql<{ id: string }[]>`
    select id from auth.users where email = ${email}`;

  return row ? { id: row.id, email } : null;
}

// The rows the harness seeds for the caller: one group it leads, the three
// accounts a movement needs both ends of, and one category and label to file it under.
export type HarnessScope = {
  groupId: string;
  assetAccountId: string;
  cashAccountId: string;
  liabilityAccountId: string;
  categoryId: string;
  labelId: string;
};

export type HarnessUser = { id: string; email: string };

const tracked = new Map<FixtureTable, string[]>();

export function track(table: FixtureTable, id: string): void {
  const ids = tracked.get(table);
  if (ids) ids.push(id);
  else tracked.set(table, [id]);
}

/**
 * The run's own user, created here and dropped at the end, so runs repeat and no
 * real user's data is ever read or written. `id` is the only column `auth.users`
 * requires; a real sign-in fills the rest and nothing here reads them.
 */
export async function createHarnessUser(): Promise<string> {
  const { id, email } = await createUser();

  // The Supabase stub reads these, so they are set before any app module runs.
  process.env.HARNESS_USER_ID = id;
  process.env.HARNESS_USER_EMAIL = email;

  return id;
}

/**
 * A second user of the same make, left out of every group: `seedHarnessScope`
 * turns the run's own user into a leader, and RF-55 holds a user to one live
 * membership, so a create-a-fund path can only be driven by someone else.
 * Sets no environment: `asUser` decides when a call speaks for this identity.
 */
export async function createMembershipFreeUser(): Promise<HarnessUser> {
  return createUser();
}

async function createUser(): Promise<HarnessUser> {
  const id = randomUUID();
  const email = `harness-${id}@example.invalid`;

  // Opens this process's run on first use; every later call finds one already
  // open and spends no round trip on it.
  await openRun(currentSuite, fixtureSql);
  await registerEphemeralIdentity(fixtureSql, { id, email });

  return { id, email };
}

/**
 * Runs `fn` under another identity by moving the claims the Supabase stub reads.
 * `getVerifiedClaims` memoises through React's `cache`, which no-ops outside a
 * request, so each call re-reads the environment. Restores it even on a throw.
 */
export async function asUser<T>(
  user: HarnessUser,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = {
    id: process.env.HARNESS_USER_ID,
    email: process.env.HARNESS_USER_EMAIL,
  };

  process.env.HARNESS_USER_ID = user.id;
  process.env.HARNESS_USER_EMAIL = user.email;

  try {
    return await fn();
  } finally {
    // Assigning `undefined` would store the string "undefined" and hand the stub
    // a subject that is not a user.
    if (previous.id === undefined) delete process.env.HARNESS_USER_ID;
    else process.env.HARNESS_USER_ID = previous.id;
    if (previous.email === undefined) delete process.env.HARNESS_USER_EMAIL;
    else process.env.HARNESS_USER_EMAIL = previous.email;
  }
}

// The claims the stamping triggers read: a delete runs as the owner role but
// settles these first, so `auth.uid()` resolves inside every trigger it fires —
// the audit row it causes then names an actor `purgeAuditTrail` can find again.
function claimsFor(userId: string): string {
  return JSON.stringify({
    sub: userId,
    role: "authenticated",
    aud: "authenticated",
  });
}

/**
 * Settles the claims of `userId` in one statement, then runs `fn` in the same
 * transaction. Every audit row the deletes below cause then carries `userId` as
 * actor and is reachable by `purgeAuditTrail`.
 */
export async function asOwner(
  userId: string,
  fn: (tx: TransactionSql) => Promise<void>,
): Promise<void> {
  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claimsFor(userId)}, true)`;
    await fn(tx);
  });
}

/**
 * Every row `userId` owns, child before parent, ending at `app_users` and
 * `auth.users`. Bounded to one id; it names no pattern and no window. Mirrors
 * `e2e/global-setup.ts:purge`, which already survives `assert_group_keeps_leader`
 * and the `debt_terms` RESTRICT — including deleting a group by membership alone,
 * so a group this identity only belongs to (never leads) still comes down, and
 * whatever else it held under that group's scope rides its cascade.
 */
export async function purgeIdentity(userId: string): Promise<void> {
  await asOwner(userId, async (tx) => {
    await tx`delete from ingest_deliveries where owner_user_id = ${userId}`;
    await tx`delete from ingest_shapes where owner_user_id = ${userId}`;
    // Neither learned-memory table is named: a trusted row rides the cascade from the
    // category or the account it trusts (0043), and every other row rides `app_users`.
    // A contribution is named before its goal even though it cascades: an aporte
    // that outlived its goal would be a leak no later count could explain.
    await tx`
      delete from goal_contributions
      where goal_id in (select id from savings_goals where owner_user_id = ${userId})`;
    await tx`delete from savings_goals where owner_user_id = ${userId}`;
    await tx`delete from budgets where owner_user_id = ${userId}`;
    await tx`delete from planned_payments where owner_user_id = ${userId}`;
    // These three hang off an account rather than off a user. `debt_terms` goes
    // before `accounts` in particular: its row is what makes an account's deletion
    // fail rather than cascade.
    await tx`
      delete from installment_plans
      where account_id in (select id from accounts where owner_user_id = ${userId})`;
    await tx`
      delete from account_statements
      where account_id in (select id from accounts where owner_user_id = ${userId})`;
    await tx`
      delete from debt_terms
      where account_id in (select id from accounts where owner_user_id = ${userId})`;
    // Splits and labels ride the movement's cascade.
    await tx`delete from transactions where owner_user_id = ${userId}`;
    await tx`delete from recurring_rules where owner_user_id = ${userId}`;
    await tx`delete from webhook_credentials where owner_user_id = ${userId}`;
    await tx`delete from labels where owner_user_id = ${userId}`;
    await tx`delete from categories where owner_user_id = ${userId}`;
    await tx`delete from accounts where owner_user_id = ${userId}`;
    // The group goes before its members: `assert_group_keeps_leader` refuses to
    // leave a live group leaderless, and the cascade from a deleted group is the
    // one path that may take a leader row — or a `created_by` on a group-scoped
    // row this identity never owned outright — with it.
    await tx`
      delete from groups
      where id in (select group_id from group_members where user_id = ${userId})`;
    await tx`delete from group_members where user_id = ${userId}`;
    // The auth row cascades to `app_users`; both are named so the deletion is
    // stated, not inferred from a foreign key.
    await tx`delete from app_users where id = ${userId}`;
    await tx`delete from auth.users where id = ${userId}`;
  });
}

/**
 * The trail those deletes stamped. Same shape as `e2e/global-setup.ts`: bounded
 * to the ids named, on the two columns that name a person, so a real user's row
 * is never reachable from here. A no-op on an empty list — `in ()` is not valid
 * SQL, and an identity nothing touched has nothing to purge.
 */
export async function purgeAuditTrail(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;

  await fixtureSql`
    delete from audit_log
    where actor_user_id in ${fixtureSql(userIds)}
       or owner_user_id in ${fixtureSql(userIds)}`;
}

/**
 * The rows the suites read and write against. Written under the harness user's
 * claims but WITHOUT the role switch: the stamping triggers read `auth.uid()`
 * and see them, while the owner's privileges do the writing — so a fixture never
 * has to satisfy the column grants the code under test is measured against.
 */
export async function seedHarnessScope(userId: string): Promise<HarnessScope> {
  const scope: HarnessScope = {
    groupId: randomUUID(),
    assetAccountId: randomUUID(),
    cashAccountId: randomUUID(),
    liabilityAccountId: randomUUID(),
    categoryId: randomUUID(),
    labelId: randomUUID(),
  };
  const memberId = randomUUID();
  const claims = JSON.stringify({
    sub: userId,
    role: "authenticated",
    aud: "authenticated",
  });

  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;

    await tx`
      insert into groups (id, name, cash_mode)
      values (${scope.groupId}, 'Harness fund', 'per_member')`;

    await tx`
      insert into group_members (id, group_id, user_id, name, role)
      values (${memberId}, ${scope.groupId}, ${userId}, 'Harness leader', 'leader')`;

    // Personal placement throughout: the group exists so the group-scoped reads
    // take their non-empty branch, not so the fixtures live inside it.
    const today = tx`(now() at time zone ${TIME_ZONE})::date`;
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values
        (${scope.assetAccountId}, ${userId}, 'Harness bank', 'asset', 'bancaria', 5000000, ${today}),
        (${scope.cashAccountId}, ${userId}, 'Harness cash', 'asset', 'efectivo', 0, ${today}),
        (${scope.liabilityAccountId}, ${userId}, 'Harness card', 'liability', 'tarjeta', -300000, ${today})`;

    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${scope.categoryId}, ${userId}, 'Harness groceries', 'expense', '#4C8C4A')`;

    await tx`
      insert into labels (id, owner_user_id, name, color)
      values (${scope.labelId}, ${userId}, 'Harness label', '#4C8C4A')`;
  });

  track("groups", scope.groupId);
  track("group_members", memberId);
  track("accounts", scope.assetAccountId);
  track("accounts", scope.cashAccountId);
  track("accounts", scope.liabilityAccountId);
  track("categories", scope.categoryId);
  track("labels", scope.labelId);

  return scope;
}

/**
 * The email `session.ts` mints for this lane's leader identity, by the same
 * formula as its `HARNESS_EMAIL` — not imported from there: `session.ts` imports
 * `fixtureSql` from this file, so importing it back would close a cycle (the
 * same reason `registry.ts`'s `harnessLane()` duplicates rather than imports).
 * Deterministic, not a guess: this process already knows its own lane from
 * `HARNESS_LANE`, the same fact every other harness pool names itself by.
 */
function laneSharedEmail(): string {
  const lane = process.env.HARNESS_LANE?.trim() ?? "";
  if (lane !== "" && lane !== "1" && !/^[1-9][0-9]*$/.test(lane)) {
    throw new Error(`HARNESS_LANE must be a positive integer, not "${lane}"`);
  }

  return `harness${lane === "" || lane === "1" ? "" : `-${lane}`}@example.invalid`;
}

// The tracked-id deletes, run under whichever `sql` the caller hands in — bare
// `fixtureSql` or a transaction already carrying a settled `auth.uid()`.
async function deleteTracked(sql: Sql | TransactionSql): Promise<void> {
  for (const [table, idColumn] of CLEANUP_ORDER) {
    const ids = tracked.get(table);
    if (ids === undefined || ids.length === 0) continue;

    await sql`
      delete from ${sql(table)}
      where ${sql(idColumn)} in ${sql(ids)}`;
  }
}

/**
 * Drops every ephemeral identity this run registered — everything it owns, then
 * the identity itself — then whatever the tracked-id path still names (a shared
 * identity's rows, which are never owned by dropping the identity), then the
 * trail all of that stamped, then closes the run.
 *
 * The tracked-id path never reads `registeredIdentities(sql, "shared")`: that
 * set is global across every lane — a shared row hangs off no run by its own
 * CHECK — so filtering the purge by it would delete another lane's live audit
 * trail the moment more than one lane's identity is shared
 * (`private/planes/plan-datos-de-prueba.md`, «Two answers module 3 forced»).
 * Instead the deletes run under `laneSharedEmail`, this lane's own identity and
 * nothing broader, so the rows they touch stamp that identity as actor and
 * `purgeAuditTrail` can find them again — never both-null. A run that tracked
 * nothing never looks the identity up at all.
 *
 * Each identity gets its own try/catch: one identity's undeletable row no longer
 * costs every later identity its cleanup. Every failure is recorded and the
 * function still throws at the end, naming every id it could not drop — the
 * leak is now visible instead of silent.
 *
 * `closeRun` runs only when nothing failed. A partial cleanup must keep looking
 * unfinished: its `unref()`ed heartbeat stops with this process, the run ages
 * past 30 minutes, and module 10's reaper — keyed on `finished_at is null` plus
 * a stale heartbeat — takes the identity this call could not. A run that
 * dropped everything still closes normally.
 */
export async function cleanup(): Promise<void> {
  const tripsBefore = statements;
  const failed: string[] = [];

  try {
    const ephemeralIds = await registeredIdentities(fixtureSql, "ephemeral");
    const dropped: string[] = [];

    for (const userId of ephemeralIds) {
      try {
        await purgeIdentity(userId);
        dropped.push(userId);
      } catch (error) {
        console.error(
          `cleanup: identity ${userId} did not drop — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        failed.push(userId);
      }
    }

    const hasTrackedRows = [...tracked.values()].some((ids) => ids.length > 0);
    const laneUser = hasTrackedRows
      ? await findUserByEmail(laneSharedEmail())
      : null;

    if (laneUser) {
      await asOwner(laneUser.id, deleteTracked);
    } else {
      await deleteTracked(fixtureSql);
    }

    await purgeAuditTrail(laneUser ? [...dropped, laneUser.id] : dropped);

    if (dropped.length > 0) {
      // No foreign key ties this row to `auth.users` (migration 0039), so it
      // outlives the identity it names until dropped here, by hand.
      await fixtureSql`delete from harness.identities where user_id in ${fixtureSql(dropped)}`;
    }

    if (failed.length === 0) {
      await closeRun(fixtureSql);
    }

    if (failed.length > 0) {
      throw new Error(
        `cleanup: ${failed.length} identity(ies) still own rows nothing here could drop: ${failed.join(", ")}`,
      );
    }
  } finally {
    console.log(`REPORT  cleanup — ${statements - tripsBefore} round trips.`);
    await fixtureSql.end();
  }
}
