/**
 * Drives every policy and grant on `goals` against the real database — and the
 * guard-and-settle body `lib/session.ts`'s `withGoalsDb` runs before every
 * query — instead of reading either from a migration (AGENTS.md, "Code").
 *
 * Three parts, in the shape of `apps/wordbook/scripts/check-sync.ts`:
 *
 * Part 1 drives RLS and grants. Two `randomUUID()` subjects, their
 * `auth.users` rows inserted inside one transaction that always throws at the
 * end to force a ROLLBACK, so nothing survives it and `harness:census` does
 * not move — `@repo/harness-registry` is never needed. Every risky attempt
 * runs inside its own savepoint, so one `42501` never aborts the ones after
 * it. `anon` is driven too and refused everything.
 *
 * Part 2 calls `withSettledTransaction` (`@/lib/settled-transaction`)
 * directly — the exact function `withGoalsDb` calls, not a copy of it — so a
 * mutation *inside that function* turns this script red, from either call
 * site. This alone does **not** prove `lib/session.ts` still calls it, or
 * calls it correctly: a rewrite of `withSettledDb` that skips
 * `withSettledTransaction` entirely, or hands it an adapter that never
 * executes the statement it is given, is invisible to Part 2 — neither
 * mutation touches the function Part 2 imports. `P27` also reads a *second*,
 * later connection on the same pool to check nothing leaked past the first
 * one's commit; that comparison is only meaningful when both queries land on
 * the same physical backend — measured (`docs/TRAPS.md`, "claims (and role)
 * can survive a connection through the pooler") to land on a *different* one
 * often enough, under Supavisor's transaction pooling, to both flag correct
 * code and miss a real regression. `P27` reads `pg_backend_pid()` from both
 * queries, retries the bare one once on a mismatch, and reports
 * `INCONCLUSIVE` — never `PASS` — if the two still disagree: an unmeasured
 * comparison must never look like a clean one. `P26`, which checks the settle
 * from inside its own single transaction on its own connection, needs none of
 * this.
 *
 * Part 3 closes the Part-2 gap: it imports `withGoalsDb`/`withReadingDb`
 * themselves from `lib/session.ts` and drives them for real, so a rewrite
 * that skips `withSettledTransaction` — invisible to Part 2 — turns this red
 * too (and, as it happens, also breaks the no-session guard, which is what
 * `P34` below catches). `verifiedClaims` is the one thing genuinely out of
 * reach here — it needs `next/headers`'s `cookies()`, which throws outside a
 * request (the same wall orbit hit) — so
 * `@repo/supabase-auth` is mocked with `node:test`'s `mock.module`
 * (`--experimental-test-module-mocks`, the same flag `check:unit` already
 * runs under) to hand back a canned session without ever calling
 * `createSupabaseServerClient`. `server-only`, which `lib/session.ts` and
 * `@/db/client` both import at their top, is not mockable that way —
 * `mock.module` still resolves the real specifier first — so `NODE_PATH`
 * points this script alone at `scripts/node-stubs/server-only`, a local
 * no-op stand-in `next dev`/`next build` never sees (they never read
 * `NODE_PATH`, and nothing under `scripts/` is on their module path). What
 * runs after that is `lib/session.ts` itself, unmodified, importing the real
 * `@/db/client` and calling the real `withSettledTransaction`.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mock } from "node:test";
import { isDeepStrictEqual } from "node:util";

import { assertSuiteDatabase } from "@repo/harness-registry";
import { createClient } from "@supabase/supabase-js";
import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/db/schema";
import { withSettledTransaction } from "@/lib/settled-transaction";
import { civilDateInZone, civilDateToDate, todayInZone } from "@/lib/zone";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is not set");

let failed = false;

function assert(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!ok) failed = true;
}

// Nothing here goes through drizzle, so the driver's own PostgresError is the
// thrown value — no cause chain to walk.
function pgCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error as { code: unknown };
  return typeof code === "string" ? code : undefined;
}

// Runs `fn` in its own savepoint, so a `42501` it throws never aborts the
// attempts that follow inside the same outer transaction.
async function attempt(
  tx: postgres.TransactionSql,
  fn: (sp: postgres.TransactionSql) => Promise<unknown>,
): Promise<{ code?: string }> {
  let code: string | undefined;
  await tx.savepoint((sp) => fn(sp)).catch((error: unknown) => {
    code = pgCode(error);
  });
  return { code };
}

// The same shape as `attempt`, keeping the rows a successful statement
// `returning`s — the rename and archive checks need to read back what a rename or
// an archive actually wrote, not only whether it was refused. Also what
// keeps this suite from crashing outright when run *before* `0004` is
// applied: `archived_at` does not exist yet, so a bare `update ... set
// archived_at = ...` would abort the whole outer transaction without a
// savepoint under it.
async function attemptRows<T>(
  tx: postgres.TransactionSql,
  fn: (sp: postgres.TransactionSql) => Promise<T[]>,
): Promise<{ rows: T[]; code?: string }> {
  let rows: T[] = [];
  let code: string | undefined;
  await tx.savepoint(async (sp) => {
    rows = await fn(sp);
  }).catch((error: unknown) => {
    code = pgCode(error);
  });
  return { rows, code };
}

// Same shape again, for an UPDATE with no `returning`: what a cross-identity
// attempt needs, since post-`0004` it is refused by RLS alone — a real
// statement that runs and affects zero rows, never an error — while
// pre-`0004` the same statement is refused by the grant (`name`) or by a
// column that does not exist yet (`archived_at`), which does throw. `count`
// stays `0` either way, so "0 rows or 42501" (the contract's own words) is
// one assertion regardless of which side of the migration this runs on.
async function attemptCount(
  tx: postgres.TransactionSql,
  fn: (sp: postgres.TransactionSql) => Promise<{ count: number }>,
): Promise<{ count: number; code?: string }> {
  let count = 0;
  let code: string | undefined;
  await tx.savepoint(async (sp) => {
    count = (await fn(sp)).count;
  }).catch((error: unknown) => {
    code = pgCode(error);
  });
  return { count, code };
}

// Mirrors `withGoalsDb` (`apps/goallog/lib/session.ts`): one statement, not
// four, and transaction-local (`true`), so re-pointing mid-transaction is
// safe — it never reaches across a reused connection.
async function enterUserContext(tx: postgres.TransactionSql, subject: string): Promise<void> {
  const claims = JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" });
  await tx`select
    set_config('request.jwt.claims', ${claims}, true),
    set_config('statement_timeout', '8000', true),
    set_config('search_path', 'goals, public', true),
    set_config('role', 'authenticated', true)`;
}

type Fixtures = {
  goalId: string;
  phaseId: string;
  commitmentId: string;
  factId: string;
  oneOffId: string;
};

// One row of each of the four nouns, plus a phase, for a subject already
// settled into its own context — enough for every cross-identity check below,
// `phases` and `commitments` included ("driven through the
// door at all").
async function seedFixtures(tx: postgres.TransactionSql, userId: string): Promise<Fixtures> {
  const [goal] = await tx<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${userId}, 'meta de prueba', '2026-12-31') returning id`;
  const [phase] = await tx<{ id: string }[]>`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${userId}, ${goal.id}, 'fase de prueba', '2026-01-01', '2026-12-31') returning id`;
  const [commitment] = await tx<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
    values (${userId}, ${goal.id}, 'compromiso de prueba', 'daily', 'tap') returning id`;
  const [fact] = await tx<{ id: string }[]>`
    insert into goals.facts (user_id, commitment_id, day)
    values (${userId}, ${commitment.id}, '2026-09-22') returning id`;
  const [oneOff] = await tx<{ id: string }[]>`
    insert into goals.one_offs (user_id, name) values (${userId}, 'suelto de prueba') returning id`;

  return {
    goalId: goal.id,
    phaseId: phase.id,
    commitmentId: commitment.id,
    factId: fact.id,
    oneOffId: oneOff.id,
  };
}

async function checkPoliciesAndGrants(sql: postgres.Sql): Promise<void> {
  const subject = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  // Scoped to these two synthetic ids, never a bare `count(*)`: five lanes
  // share this database and another one's own facts land in this table while
  // this runs (measured live: a `harness-5@example.invalid` row mid-run).
  const [before] = await sql<{ count: string }[]>`
    select count(*)::text as count from goals.facts where user_id in (${subject}, ${intruder})`;

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;

      await enterUserContext(tx, subject);
      const a = await seedFixtures(tx, subject);

      await enterUserContext(tx, intruder);
      const b = await seedFixtures(tx, intruder);

      await enterUserContext(tx, subject);

      // -- SELECT another person's row of every noun: filtered to zero rows,
      // never an error (RNP-05) --
      const foreignGoal = await tx<{ id: string }[]>`select id from goals.goals where id = ${b.goalId}`;
      assert("P01", foreignGoal.length === 0, `another person's goal, rows visible = ${foreignGoal.length}`);

      const foreignPhase = await tx<{ id: string }[]>`select id from goals.phases where id = ${b.phaseId}`;
      assert("P02", foreignPhase.length === 0, `another person's phase, rows visible = ${foreignPhase.length}`);

      const foreignCommitment = await tx<{ id: string }[]>`
        select id from goals.commitments where id = ${b.commitmentId}`;
      assert(
        "P03",
        foreignCommitment.length === 0,
        `another person's commitment, rows visible = ${foreignCommitment.length}`,
      );

      const foreignFact = await tx<{ id: string }[]>`select id from goals.facts where id = ${b.factId}`;
      assert("P04", foreignFact.length === 0, `another person's fact, rows visible = ${foreignFact.length}`);

      const foreignOneOff = await tx<{ id: string }[]>`select id from goals.one_offs where id = ${b.oneOffId}`;
      assert("P05", foreignOneOff.length === 0, `another person's one-off, rows visible = ${foreignOneOff.length}`);

      // -- cross-identity INSERT refused by `WITH CHECK`, one per owned table:
      // it was first named for `facts` alone, then as
      // structurally unseen everywhere else `WITH CHECK` also guards --
      const insertGoal = await attempt(
        tx,
        (sp) => sp`insert into goals.goals (user_id, name, horizon)
          values (${intruder}, 'ajena', '2026-01-01')`,
      );
      assert("P06", insertGoal.code === "42501", `insert goal as another user, sqlstate = ${insertGoal.code ?? "none"}`);

      const insertPhase = await attempt(
        tx,
        (sp) => sp`insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
          values (${intruder}, ${a.goalId}, 'ajena', '2026-01-01', '2026-01-02')`,
      );
      assert(
        "P07",
        insertPhase.code === "42501",
        `insert phase as another user, sqlstate = ${insertPhase.code ?? "none"}`,
      );

      const insertCommitment = await attempt(
        tx,
        (sp) => sp`insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
          values (${intruder}, ${a.goalId}, 'ajeno', 'daily', 'tap')`,
      );
      assert(
        "P08",
        insertCommitment.code === "42501",
        `insert commitment as another user, sqlstate = ${insertCommitment.code ?? "none"}`,
      );

      const insertOneOff = await attempt(
        tx,
        (sp) => sp`insert into goals.one_offs (user_id, name) values (${intruder}, 'ajeno')`,
      );
      assert(
        "P09",
        insertOneOff.code === "42501",
        `insert one-off as another user, sqlstate = ${insertOneOff.code ?? "none"}`,
      );

      const insertFact = await attempt(
        tx,
        (sp) => sp`insert into goals.facts (user_id, commitment_id, day)
          values (${intruder}, ${a.commitmentId}, '2026-09-22')`,
      );
      assert("P10", insertFact.code === "42501", `insert fact as another user, sqlstate = ${insertFact.code ?? "none"}`);

      // -- UPDATE: the grant layer narrows every column, not the policy alone --
      const updateFact = await attempt(tx, (sp) => sp`update goals.facts set note = 'x' where id = ${a.factId}`);
      assert("P11", updateFact.code === "42501", `update a fact at all, sqlstate = ${updateFact.code ?? "none"}`);

      // `name` opened in 0022 (P274); `unit` is one of the columns still closed.
      const updateCommitmentUnit = await attempt(
        tx,
        (sp) => sp`update goals.commitments set unit = 'km' where id = ${a.commitmentId}`,
      );
      assert(
        "P12",
        updateCommitmentUnit.code === "42501",
        `update commitment.unit, sqlstate = ${updateCommitmentUnit.code ?? "none"}`,
      );

      const retireCommitment = await attempt(
        tx,
        (sp) => sp`update goals.commitments set retired_at = now() where id = ${a.commitmentId} returning id`,
      );
      assert(
        "P13",
        retireCommitment.code === undefined,
        `update commitment.retired_at, sqlstate = ${retireCommitment.code ?? "none (succeeded)"}`,
      );

      // 0025 grants `aim`, `starts_on`, `ends_on` (P19c); every other column of a phase stays closed.
      const updatePhase = await attempt(
        tx,
        (sp) => sp`update goals.phases set created_at = '2020-01-01T00:00:00Z' where id = ${a.phaseId}`,
      );
      assert("P14", updatePhase.code === "42501", `update phase.created_at, sqlstate = ${updatePhase.code ?? "none"}`);

      const updateGoalMeasure = await attempt(
        tx,
        (sp) => sp`update goals.goals set measure_name = 'km', measure_unit = 'km' where id = ${a.goalId}`,
      );
      assert(
        "P15",
        updateGoalMeasure.code === undefined,
        `update goal's measure pair, sqlstate = ${updateGoalMeasure.code ?? "none (succeeded)"}`,
      );

      // RP-23: `name` is now grantable to the owner alone — the
      // grant `0004_melodic_dreadnoughts.sql` adds, proved here rather than
      // only in `checkGoalRenameArchiveGrant` below, so a regression to
      // "column not granted" still turns this very P-number red. Red before
      // that migration applies (permission denied), green after.
      const updateGoalName = await attemptRows<{ id: string; name: string }>(
        tx,
        (sp) => sp`update goals.goals set name = 'renombrada' where id = ${a.goalId} returning id, name`,
      );
      assert(
        "P16",
        updateGoalName.code === undefined &&
          updateGoalName.rows.length === 1 &&
          updateGoalName.rows[0].name === "renombrada",
        `update own goal.name, sqlstate = ${updateGoalName.code ?? "none"}, rows = ${updateGoalName.rows.length}`,
      );

      // -- DELETE: another person's row never disappears; an own row no fact
      // depends on does (RP-127; the refusals are `checkDeleteAndEdit0025`) --
      const deleteForeignFact = await tx`delete from goals.facts where id = ${b.factId}`;
      assert("P17", deleteForeignFact.count === 0, `delete another person's fact, rows deleted = ${deleteForeignFact.count}`);

      // RP-127: what no fact depends on deletes. `a.commitmentId` explains `a.factId`, so a fresh one.
      const [factless] = await tx<{ id: string }[]>`
        insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
        values (${subject}, ${a.goalId}, 'sin hechos', 'daily', 'tap') returning id`;
      const deleteCommitment = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`delete from goals.commitments where id = ${factless.id} returning id`,
      );
      assert(
        "P18",
        deleteCommitment.code === undefined && deleteCommitment.rows.length === 1,
        `delete own fact-less commitment, sqlstate = ${deleteCommitment.code ?? "none"}, rows = ${deleteCommitment.rows.length}`,
      );

      const deletePhase = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`delete from goals.phases where id = ${a.phaseId} returning id`,
      );
      assert(
        "P19",
        deletePhase.code === undefined && deletePhase.rows.length === 1,
        `delete own phase, sqlstate = ${deletePhase.code ?? "none"}, rows = ${deletePhase.rows.length}`,
      );

      // -- evidence_sources: configuration, read-only to everyone --
      const insertSource = await attempt(
        tx,
        (sp) => sp`insert into goals.evidence_sources (key, label_key, unit) values ('forged', 'x', 'x')`,
      );
      assert("P20", insertSource.code === "42501", `insert evidence source, sqlstate = ${insertSource.code ?? "none"}`);

      const readSources = await tx<{ key: string }[]>`select key from goals.evidence_sources`;
      assert(
        "P21",
        readSources.some((row) => row.key === "reading_lookups"),
        `evidence sources visible = ${readSources.map((row) => row.key).join(",") || "none"}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  // `anon` holds no `USAGE` on the `goals` schema at all — denied before RLS
  // is ever asked, for a read and for a write alike.
  await sql
    .begin(async (tx) => {
      await tx`select set_config('role', 'anon', true)`;

      const anonSelectGoals = await attempt(tx, (sp) => sp`select 1 from goals.goals limit 1`);
      assert("P22", anonSelectGoals.code === "42501", `anon select goals, sqlstate = ${anonSelectGoals.code ?? "none"}`);

      const anonSelectFacts = await attempt(tx, (sp) => sp`select 1 from goals.facts limit 1`);
      assert("P23", anonSelectFacts.code === "42501", `anon select facts, sqlstate = ${anonSelectFacts.code ?? "none"}`);

      const anonInsertFact = await attempt(
        tx,
        (sp) => sp`insert into goals.facts (user_id, commitment_id, day)
          values (${randomUUID()}, ${randomUUID()}, '2026-09-22')`,
      );
      assert("P24", anonInsertFact.code === "42501", `anon insert fact, sqlstate = ${anonInsertFact.code ?? "none"}`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [after] = await sql<{ count: string }[]>`
    select count(*)::text as count from goals.facts where user_id in (${subject}, ${intruder})`;
  assert(
    "P25",
    before.count === "0" && after.count === "0",
    `facts for these two subjects, before = ${before.count}, after = ${after.count}`,
  );
}

// The two adapters `withSettledTransaction` needs to run on a raw `postgres`
// connection instead of drizzle's: `begin` opens this driver's own
// transaction (the same `UnwrapPromiseArray` cast `lib/session.ts` needs for
// `db.transaction`), `run` turns the `SQL` object `settleSessionSql` returns
// into the text-and-params `tx.unsafe` takes.
function beginOn(sql: postgres.Sql) {
  return <T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> => sql.begin(fn) as Promise<T>;
}

async function runOn(tx: postgres.TransactionSql, statement: SQL): Promise<unknown> {
  const query = new PgDialect().sqlToQuery(statement);
  return tx.unsafe(query.sql, query.params as string[]);
}

async function checkSettleMechanism(): Promise<void> {
  const wire: { connId: number; sql: string }[] = [];
  const sql = postgres(DATABASE_URL!, {
    prepare: false,
    max: 1,
    debug: (connId, query) => wire.push({ connId, sql: query }),
  });

  const session = { claims: { sub: randomUUID(), role: "authenticated", aud: "authenticated" } };

  // With a session: the real `withSettledTransaction` actually seats the role
  // and drops BYPASSRLS, driven end to end rather than asserted from the file
  // — the very function `withGoalsDb` calls, not a copy of it.
  const [seated] = await withSettledTransaction<
    postgres.TransactionSql,
    { role: string; bypasses: boolean; pid: number }[]
  >(session, "check-policies", "goals, public", beginOn(sql), runOn, (tx) =>
    tx<{ role: string; bypasses: boolean; pid: number }[]>`
      select current_user as role,
             (select rolbypassrls from pg_roles where rolname = current_user) as bypasses,
             pg_backend_pid() as pid`,
  );
  assert(
    "P26",
    seated.role === "authenticated" && seated.bypasses === false,
    `role = ${seated.role}, bypassrls = ${seated.bypasses}`,
  );

  // `is_local = true` (the third argument to every `set_config` in
  // `settleSessionSql`) is what keeps the settle from surviving its own
  // transaction. `max: 1` keeps one persistent client socket open for `sql`'s
  // whole life, but under Supavisor's transaction pooling that socket can
  // still be handed a *different* upstream backend for this bare query than
  // `seated` ran on — measured (`docs/TRAPS.md`, "claims (and role) can
  // survive a connection through the pooler") to both flag correct code and
  // miss a real regression under contention. The comparison below only means
  // something when both queries land on the same backend: read
  // `pg_backend_pid()` from both, retry the bare query once on a mismatch,
  // and report inconclusive — never a PASS — if it still does not match. An
  // unearned PASS is what lets the regression through; a visible
  // "inconclusive" does not.
  async function bareRoleAndPid(): Promise<{ role: string; pid: number }> {
    const [row] = await sql<{ role: string; pid: number }[]>`select current_user as role, pg_backend_pid() as pid`;
    return row;
  }

  let bare = await bareRoleAndPid();
  if (bare.pid !== seated.pid) bare = await bareRoleAndPid();

  if (bare.pid !== seated.pid) {
    console.log(
      `INCONCLUSIVE  P27 — seated on backend pid ${seated.pid}, the bare query landed on pid ${bare.pid} twice; ` +
        `nothing measured about whether the settle leaked`,
    );
  } else {
    assert("P27", bare.role !== "authenticated", `role on backend pid ${bare.pid} after commit = ${bare.role}`);
  }

  // Without a session: the guard must throw before `sql.begin` ever runs, so
  // zero statements reach the wire — read from this pool's own instrumented
  // log, not inferred from a flat log's first "begin" (
  // that method cannot tell one transaction's statements from another's).
  const sentBefore = wire.length;
  let threw = false;
  await withSettledTransaction(null, "check-policies", "goals, public", beginOn(sql), runOn, async () => undefined).catch(
    () => {
      threw = true;
    },
  );
  const sentWithNoSession = wire.length - sentBefore;
  assert(
    "P28",
    threw && sentWithNoSession === 0,
    `threw = ${threw}, statements sent while unauthenticated = ${sentWithNoSession}`,
  );

  await sql.end();
}

// a statement count must read its own connection, not
// assume the first "begin" in a merged log belongs to the transaction under
// test. Two real, concurrently open connections (`max: 1` each, run
// interleaved) prove the technique: every entry in one client's own debug log
// carries that client's own connection id and no other's, so counting "this
// transaction's statements" by filtering on id — never by scanning for the
// first literal "begin" — survives concurrency a flat log cannot represent.
async function checkStatementAttributionByConnection(): Promise<void> {
  const wireA: { connId: number; sql: string }[] = [];
  const wireB: { connId: number; sql: string }[] = [];
  const sqlA = postgres(DATABASE_URL!, { prepare: false, max: 1, debug: (id, query) => wireA.push({ connId: id, sql: query }) });
  const sqlB = postgres(DATABASE_URL!, { prepare: false, max: 1, debug: (id, query) => wireB.push({ connId: id, sql: query }) });

  // Barrier: each transaction holds its connection open until both have read
  // their pid, so the pooler cannot hand one backend to both. The finally
  // releases on a throw too, so one side failing never hangs the other.
  let releaseA!: () => void;
  let releaseB!: () => void;
  const readA = new Promise<void>((resolve) => (releaseA = resolve));
  const readB = new Promise<void>((resolve) => (releaseB = resolve));
  const [[pidA], [pidB]] = await Promise.all([
    sqlA.begin(async (tx) => {
      try {
        const rows = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        releaseA();
        await readB;
        return rows;
      } finally {
        releaseA();
      }
    }),
    sqlB.begin(async (tx) => {
      try {
        const rows = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        releaseB();
        await readA;
        return rows;
      } finally {
        releaseB();
      }
    }),
  ]);

  const idsA = new Set(wireA.map((entry) => entry.connId));
  const idsB = new Set(wireB.map((entry) => entry.connId));
  const disjoint = ![...idsA].some((id) => idsB.has(id));

  assert(
    "P29",
    pidA.pid !== pidB.pid && idsA.size === 1 && idsB.size === 1 && disjoint,
    `two interleaved transactions, backend pids ${pidA.pid} / ${pidB.pid}, ` +
      `wire connection ids {${[...idsA]}} / {${[...idsB]}}, disjoint = ${disjoint}`,
  );

  await sqlA.end();
  await sqlB.end();
}

// the real `@supabase/supabase-js` client, not a stub whose
// notion of "verified" is an environment variable.
async function checkRealClientRejectsBadTokens(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are not set");

  const client = createClient(url, key);

  // A real network round trip against Supabase's own JWKS/verification
  // endpoint — the same call `verifiedClaims` makes — rejects a token that
  // never had a valid signature to begin with.
  const garbage = await client.auth.getClaims("this.is-not.a-jwt");
  assert("P30", garbage.error !== null, `getClaims on a malformed token, error = ${garbage.error?.message ?? "none"}`);

  // Anonymous sign-in is off at the project level. This app's own `lib/env.ts`
  // holds no service-role key on purpose ("a service_role key would bypass
  // every RLS policy"), so a script here has no way to delete a row it might
  // mint by actually signing in anonymously — RNP-09 forbids minting one
  // this app cannot register and clean up. The boundary is proven at the
  // settings door, live against the real project, instead.
  const settings = (await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } }).then((response) =>
    response.json(),
  )) as { external?: { anonymous_users?: boolean } };
  assert(
    "P31",
    settings.external?.anonymous_users === false,
    `external.anonymous_users = ${settings.external?.anonymous_users}`,
  );
}

type RealDoorSession = { claims: Record<string, unknown>; user: { id: string; email: string } };

// Mutable so `verifiedClaims`'s mock — registered once, below — can hand back
// a different answer per call without re-registering the mock: `mock.module`
// must land before `@/lib/session` is ever imported, so this closes over a
// variable this function sets before each call to the real door.
let realDoorSession: RealDoorSession | null = null;

// Closes the gap Part 2 cannot: `withSettledTransaction` being real and
// shared proves a mutation *inside* it is caught from every call site, but
// proves nothing about whether `lib/session.ts` still calls it, calls it with
// a working adapter, or calls it at all. This part imports the real
// `withGoalsDb`/`withReadingDb` and drives them — see the module docstring
// for how `server-only` and `verifiedClaims` are gotten out of the way
// without touching `lib/session.ts` itself.
async function checkRealDoor(): Promise<void> {
  mock.module("@repo/supabase-auth", {
    namedExports: {
      createSupabaseServerClient: () => {
        throw new Error("checkRealDoor: createSupabaseServerClient must not be called — verifiedClaims is mocked");
      },
      verifiedClaims: async () => realDoorSession,
    },
  });

  const { withGoalsDb, withReadingDb } = await import("@/lib/session");

  const subject = randomUUID();
  realDoorSession = {
    claims: { sub: subject, role: "authenticated", aud: "authenticated" },
    user: { id: subject, email: "check-policies@example.invalid" },
  };

  const roleQuery = `select current_user as role,
    (select rolbypassrls from pg_roles where rolname = current_user) as bypasses`;

  const [goalsSeat] = await withGoalsDb((tx) => tx.execute<{ role: string; bypasses: boolean }>(roleQuery));
  assert(
    "P32",
    goalsSeat.role === "authenticated" && goalsSeat.bypasses === false,
    `real withGoalsDb, role = ${goalsSeat.role}, bypassrls = ${goalsSeat.bypasses}`,
  );

  const [readingSeat] = await withReadingDb((tx) => tx.execute<{ role: string; bypasses: boolean }>(roleQuery));
  assert(
    "P33",
    readingSeat.role === "authenticated" && readingSeat.bypasses === false,
    `real withReadingDb, role = ${readingSeat.role}, bypassrls = ${readingSeat.bypasses}`,
  );

  realDoorSession = null;
  let threw = false;
  await withGoalsDb(async () => undefined).catch(() => {
    threw = true;
  });
  assert("P34", threw, `real withGoalsDb with no session, threw = ${threw}`);
}

// Read the grant back from the catalogue, never from the migration file:
// `facts` carried DELETE from 0000 ("undoing a tap is a delete of the whole
// row"), `one_offs` from its own migration and `month_budgets` from 0007 (a month
// amount is removed, and moved by delete and insert), and `goals`, `phases` and
// `commitments` from 0025 (RP-127). `model_calls` carries none. Takes any
// executor so a mutant run can read it inside its own rollback.
async function assertDeleteGrants(q: postgres.Sql | postgres.TransactionSql): Promise<void> {
  const grants = await q<{ table_name: string }[]>`
    select table_name from information_schema.role_table_grants
    where table_schema = 'goals' and grantee = 'authenticated' and privilege_type = 'DELETE'`;
  const tablesWithDelete = grants.map((row) => row.table_name).sort();
  assert(
    "P38",
    tablesWithDelete.join(",") === "commitments,facts,goals,month_budgets,one_offs,phases",
    `tables with DELETE granted to authenticated = ${tablesWithDelete.join(", ") || "none"}`,
  );
}

// RP-22: `one_offs_delete_self` (0000) stood inert
// until this migration's `GRANT DELETE`. Own connection, own transaction,
// own forced rollback — nothing this seeds survives it, the same shape as
// `checkPoliciesAndGrants`.
async function checkOneOffDeleteGrant(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;

      await enterUserContext(tx, subject);
      const [mine] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, name) values (${subject}, 'suelto de prueba') returning id`;
      const [goal] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon)
        values (${subject}, 'meta de prueba', '2026-12-31') returning id`;

      await enterUserContext(tx, intruder);
      const [theirs] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, name) values (${intruder}, 'ajeno') returning id`;

      await enterUserContext(tx, subject);

      // -- delete another person's one-off: the grant now lets the
      // statement run, RLS still filters it to zero rows --
      const deleteForeign = await tx`delete from goals.one_offs where id = ${theirs.id}`;
      assert(
        "P35",
        deleteForeign.count === 0,
        `delete another person's one-off, rows deleted = ${deleteForeign.count}`,
      );

      // -- delete a one-off of one's own: this is the grant this migration
      // adds, driven for real rather than read from the migration file --
      const deleteOwn = await tx<{ id: string }[]>`
        delete from goals.one_offs where id = ${mine.id} returning id`;
      assert("P36", deleteOwn.length === 1, `delete own one-off, rows deleted = ${deleteOwn.length}`);

      // An own goal no fact depends on deletes (RP-127). Its children: P37 in `checkDeleteAndEdit0025`.
      const deleteGoal = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`delete from goals.goals where id = ${goal.id} returning id`,
      );
      assert(
        "P37a",
        deleteGoal.code === undefined && deleteGoal.rows.length === 1,
        `delete own empty goal, sqlstate = ${deleteGoal.code ?? "none"}, rows = ${deleteGoal.rows.length}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  await assertDeleteGrants(sql);

  await sql.end();
}

// The invariant "an own one-off that carries a fact is not deleted" lives in
// `deleteOneOff`'s own check, not in the grant layer. `one_offs_delete_self`'s
// `USING` (migration 0002) is what closes that for a bare `DELETE` under a
// settled session: this drives that statement, never `deleteOneOff`, so a regression in any
// future writer is caught here too, not only in this app's own action.
async function checkOneOffWithFactRefusedByPolicy(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject})`;
      await enterUserContext(tx, subject);

      const [oneOff] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, name) values (${subject}, 'suelto con hecho') returning id`;
      await tx`
        insert into goals.facts (user_id, one_off_id, day)
        values (${subject}, ${oneOff.id}, '2026-09-22')`;

      // Bare, under the caller's own settled claims — no `deleteOneOff`, no
      // server action: exactly what the round-2 validator drove.
      const deleted = await tx<{ id: string }[]>`
        delete from goals.one_offs where id = ${oneOff.id} returning id`;
      assert(
        "P39",
        deleted.length === 0,
        `bare delete of an own one-off carrying a fact, rows deleted = ${deleted.length}`,
      );

      const stillThere = await tx<{ id: string }[]>`
        select id from goals.facts where one_off_id = ${oneOff.id}`;
      assert(
        "P40",
        stillThere.length === 1,
        `the fact after the refused delete, rows visible = ${stillThere.length}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  await sql.end();
}

// RP-23, RP-24: the grant `0004_melodic_dreadnoughts.sql` adds —
// `UPDATE (name, archived_at)` on `goals.goals`, to the owner alone — driven
// for real rather than read from the migration. Own connection, own
// transaction, own forced rollback, the same shape as `checkOneOffDeleteGrant`.
// Every statement below goes through `attempt`/`attemptRows`: before `0004`
// applies, `archived_at` does not exist and the grant on `name` does not
// either, so the owner's own rename/archive/reopen attempts are refused —
// this suite is meant to read red at that point, not crash. After it
// applies, they succeed and the assertions read green.
async function checkGoalRenameArchiveGrant(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;

      await enterUserContext(tx, subject);
      const [goal] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon)
        values (${subject}, 'meta original', '2026-12-31') returning id`;

      // -- the owner renames their own goal --
      const renamed = await attemptRows<{ id: string; name: string }>(
        tx,
        (sp) => sp`update goals.goals set name = 'meta renombrada' where id = ${goal.id} returning id, name`,
      );
      assert(
        "P41",
        renamed.code === undefined && renamed.rows.length === 1 && renamed.rows[0].name === "meta renombrada",
        `owner rename, sqlstate = ${renamed.code ?? "none"}, rows = ${renamed.rows.length}`,
      );

      // -- the owner archives their own goal --
      const archived = await attemptRows<{ id: string; archived_at: string | null }>(
        tx,
        (sp) => sp`update goals.goals set archived_at = now() where id = ${goal.id} returning id, archived_at`,
      );
      assert(
        "P42",
        archived.code === undefined && archived.rows.length === 1 && archived.rows[0].archived_at !== null,
        `owner archive, sqlstate = ${archived.code ?? "none"}, rows = ${archived.rows.length}`,
      );

      // -- and reopens it, the same grant running the other way --
      const reopened = await attemptRows<{ id: string; archived_at: string | null }>(
        tx,
        (sp) => sp`update goals.goals set archived_at = null where id = ${goal.id} returning id, archived_at`,
      );
      assert(
        "P43",
        reopened.code === undefined && reopened.rows.length === 1 && reopened.rows[0].archived_at === null,
        `owner reopen, sqlstate = ${reopened.code ?? "none"}, rows = ${reopened.rows.length}`,
      );

      // -- another person can neither rename nor archive: RLS narrows the
      // UPDATE to zero rows, never an error, the same shape P17's foreign
      // DELETE already takes --
      await enterUserContext(tx, intruder);
      const intruderRename = await attemptCount(
        tx,
        (sp) => sp`update goals.goals set name = 'ajena' where id = ${goal.id}`,
      );
      assert(
        "P44",
        intruderRename.count === 0,
        `another person renames it, sqlstate = ${intruderRename.code ?? "none"}, rows affected = ${intruderRename.count}`,
      );

      const intruderArchive = await attemptCount(
        tx,
        (sp) => sp`update goals.goals set archived_at = now() where id = ${goal.id}`,
      );
      assert(
        "P45",
        intruderArchive.count === 0,
        `another person archives it, sqlstate = ${intruderArchive.code ?? "none"}, rows affected = ${intruderArchive.count}`,
      );

      // -- the owner cannot move `user_id`, `horizon` or `created_at`
      // through this grant: neither column is ever named in it (`horizon` left it later) --
      await enterUserContext(tx, subject);
      const changeUserId = await attempt(
        tx,
        (sp) => sp`update goals.goals set user_id = ${intruder} where id = ${goal.id}`,
      );
      assert("P46", changeUserId.code === "42501", `owner updates goal.user_id, sqlstate = ${changeUserId.code ?? "none"}`);

      // (RP-25) grants `horizon` to the owner: it moves.
      const changeHorizon = await attempt(
        tx,
        (sp) => sp`update goals.goals set horizon = '2099-01-01' where id = ${goal.id}`,
      );
      assert("P47", changeHorizon.code === undefined, `owner updates goal.horizon, sqlstate = ${changeHorizon.code ?? "none"}`);

      const changeCreatedAt = await attempt(
        tx,
        (sp) => sp`update goals.goals set created_at = now() where id = ${goal.id}`,
      );
      assert(
        "P48",
        changeCreatedAt.code === "42501",
        `owner updates goal.created_at, sqlstate = ${changeCreatedAt.code ?? "none"}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  // Read the grant back from the catalogue, never from the migration file:
  // `goals` already carried `UPDATE (measure_name, measure_unit)` (0000);
  // this migration adds `name` and `archived_at` beside them and nothing
  // else.
  const columns = await sql<{ column_name: string }[]>`
    select column_name from information_schema.column_privileges
    where table_schema = 'goals' and table_name = 'goals'
      and grantee = 'authenticated' and privilege_type = 'UPDATE'`;
  const updatable = columns.map((row) => row.column_name).sort();
  assert(
    "P49",
    updatable.length === 9 &&
      updatable.join(",") ===
        ["archived_at", "horizon", "measure_name", "measure_unit", "name", "note", "parent_id", "plan_seen", "rhythm"]
          .sort()
          .join(","),
    `columns of goals.goals updatable by authenticated = ${updatable.join(", ") || "none"}`,
  );

  await sql.end();
}

// The civil day `n` days after `day`, read through the zone module.
function dayAfter(day: string, n: number): string {
  return civilDateInZone(new Date(civilDateToDate(day).getTime() + n * 86_400_000));
}

// RP-59, RP-25: `0005` grants `UPDATE (day)` on `one_offs` and
// `UPDATE (horizon)` on `goals`, and bounds the one-off's with
// `one_offs_update_self`. Driven bare under a settled session, own
// transaction, forced rollback.
async function checkOneOffScheduleAndHorizonGrants(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;

      await enterUserContext(tx, subject);
      const [dayless] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, name) values (${subject}, 'sin dia') returning id`;
      const [dated] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, name, day) values (${subject}, 'con dia', ${dayAfter(todayInZone(), 1)}) returning id`;
      const [withFact] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, name) values (${subject}, 'con hecho') returning id`;
      await tx`
        insert into goals.facts (user_id, one_off_id, day)
        values (${subject}, ${withFact.id}, '2026-09-22')`;
      const [goal] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon)
        values (${subject}, 'meta', '2026-12-31') returning id`;

      await enterUserContext(tx, intruder);
      const [theirs] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, name) values (${intruder}, 'ajeno') returning id`;

      await enterUserContext(tx, subject);

      const takesDay = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.one_offs set day = '2026-10-01' where id = ${dayless.id} returning id`,
      );
      assert(
        "P50",
        takesDay.code === undefined && takesDay.rows.length === 1,
        `own dayless one-off takes a day, sqlstate = ${takesDay.code ?? "none"}, rows = ${takesDay.rows.length}`,
      );

      const movesDated = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.one_offs set day = '2026-10-02' where id = ${dated.id} returning id`,
      );
      assert(
        "P51",
        movesDated.code === undefined && movesDated.rows.length === 1,
        `own one-off dated Bogota-tomorrow moves, sqlstate = ${movesDated.code ?? "none"}, rows = ${movesDated.rows.length}`,
      );

      const movesWithFact = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.one_offs set day = '2026-10-02' where id = ${withFact.id} returning id`,
      );
      assert(
        "P52",
        movesWithFact.code === undefined && movesWithFact.rows.length === 0,
        `own dayless one-off with a fact takes a day, sqlstate = ${movesWithFact.code ?? "none"}, rows = ${movesWithFact.rows.length}`,
      );

      const movesForeign = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.one_offs set day = '2026-10-02' where id = ${theirs.id} returning id`,
      );
      assert(
        "P53",
        movesForeign.code === undefined && movesForeign.rows.length === 0,
        `another person's dayless one-off takes a day, sqlstate = ${movesForeign.code ?? "none"}, rows = ${movesForeign.rows.length}`,
      );

      const renames = await attempt(
        tx,
        (sp) => sp`update goals.one_offs set name = 'otro' where id = ${dayless.id}`,
      );
      assert("P54", renames.code === undefined, `update one_offs.name, sqlstate = ${renames.code ?? "none"}`);

      const movesHorizon = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.goals set horizon = '2027-01-01' where id = ${goal.id} returning id`,
      );
      assert(
        "P55",
        movesHorizon.code === undefined && movesHorizon.rows.length === 1,
        `own goal's horizon moves, sqlstate = ${movesHorizon.code ?? "none"}, rows = ${movesHorizon.rows.length}`,
      );

      await enterUserContext(tx, intruder);
      const movesForeignHorizon = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.goals set horizon = '2027-02-01' where id = ${goal.id} returning id`,
      );
      assert(
        "P56",
        movesForeignHorizon.code === undefined && movesForeignHorizon.rows.length === 0,
        `another person's goal horizon moves, sqlstate = ${movesForeignHorizon.code ?? "none"}, rows = ${movesForeignHorizon.rows.length}`,
      );

      await enterUserContext(tx, subject);
      const createdAt = await attempt(
        tx,
        (sp) => sp`update goals.goals set created_at = now() where id = ${goal.id}`,
      );
      assert("P57", createdAt.code === "42501", `update goals.created_at, sqlstate = ${createdAt.code ?? "none"}`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  // Read from the catalogue: `one_offs` takes `day` (0005) and
  // `planned_month` (0007, the shift's one write on this table), `note`
  // (0011) and nothing else.
  const oneOffCols = await sql<{ column_name: string }[]>`
    select column_name from information_schema.column_privileges
    where table_schema = 'goals' and table_name = 'one_offs'
      and grantee = 'authenticated' and privilege_type = 'UPDATE'`;
  const oneOffUpdatable = oneOffCols.map((r) => r.column_name).sort();
  assert(
    "P58",
    oneOffUpdatable.join(",") === "day,estimate,name,note,planned_month",
    `columns of goals.one_offs updatable by authenticated = ${oneOffUpdatable.join(", ") || "none"}`,
  );

  await sql.end();
}

// A one-off's `day` changes on any row with no fact, dated today, in the past
// or ahead; a fact or a stranger refuses it. `planned_month` moves only while
// the row is undated or dated after the person's Bogota today. Driven bare
// under a settled session, forced rollback.
async function checkScheduledOneOffMoveByZone(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");
  const today = todayInZone();
  // Deliberately UTC: the one instant the zone and the server's day disagree.
  const utcDay = new Date().toISOString().slice(0, 10);
  const target = dayAfter(today, 30);

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;

      await enterUserContext(tx, subject);
      const [goal] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon)
        values (${subject}, 'meta', '2027-12-31') returning id`;
      const make = async (name: string, day: string): Promise<string> => {
        const [row] = await tx<{ id: string }[]>`
          insert into goals.one_offs (user_id, name, day) values (${subject}, ${name}, ${day}) returning id`;
        return row.id;
      };
      // A month task that also carries a day: the only shape `planned_month` can move on.
      const makeMonthTask = async (name: string, day: string): Promise<string> => {
        const [row] = await tx<{ id: string }[]>`
          insert into goals.one_offs (user_id, goal_id, name, planned_month, day)
          values (${subject}, ${goal.id}, ${name}, '2026-10-01', ${day}) returning id`;
        return row.id;
      };
      const onToday = await make("hoy", today);
      const yesterday = await make("ayer", dayAfter(today, -1));
      const withFact = await make("con hecho", dayAfter(today, 2));
      await tx`insert into goals.facts (user_id, one_off_id, day) values (${subject}, ${withFact}, ${today})`;
      const monthOnToday = await makeMonthTask("mes hoy", today);
      const monthOnUtcDay = await makeMonthTask("mes dia utc", utcDay);

      await enterUserContext(tx, intruder);
      const [theirs] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, name, day) values (${intruder}, 'ajeno', ${dayAfter(today, 3)}) returning id`;

      await enterUserContext(tx, subject);
      const moveRows = (id: string) =>
        attemptRows<{ id: string }>(
          tx,
          (sp) => sp`update goals.one_offs set day = ${target} where id = ${id} returning id`,
        );

      const cases: [string, string, number][] = [
        ["P59", onToday, 1],
        ["P60", yesterday, 1],
        ["P61", withFact, 0],
        ["P62", theirs.id, 0],
      ];
      for (const [label, id, expected] of cases) {
        const result = await moveRows(id);
        const what = { P59: "dated Bogota-today", P60: "dated yesterday", P61: "scheduled with a fact", P62: "another person's scheduled" }[label];
        assert(
          label,
          result.code === undefined && result.rows.length === expected,
          `own ${what} one-off takes a day (today = ${today}), expected rows = ${expected}, sqlstate = ${result.code ?? "none"}, rows = ${result.rows.length}`,
        );
      }

      // Only when UTC has already turned the page (19:00-24:00 Bogota) does
      // the UTC day differ from Bogota's; otherwise it is today's case again.
      const utcDiffers = utcDay !== today;
      const moveMonth = (id: string) =>
        attemptRows<{ id: string }>(
          tx,
          (sp) => sp`update goals.one_offs set planned_month = '2026-12-01' where id = ${id} returning id`,
        );
      const utc = await moveMonth(monthOnUtcDay);
      assert(
        "P63",
        utc.code === undefined && utc.rows.length === (utcDiffers ? 1 : 0),
        `month task dated on the UTC day ${utcDay} (Bogota today ${today}, differs = ${utcDiffers}) takes another month, rows = ${utc.rows.length}`,
      );

      // The session's own zone moved far east: `current_date` follows it, the
      // trigger's month rule must not. Differs from Bogota's day from 05:00 Bogota on.
      await tx`select set_config('TimeZone', 'Pacific/Kiritimati', true)`;
      const [{ far }] = await tx<{ far: string }[]>`select current_date::text as far`;
      const monthTomorrow = await makeMonthTask("mes manana", dayAfter(today, 1));
      const farToday = await moveMonth(monthOnToday);
      const farTomorrow = await moveMonth(monthTomorrow);
      assert(
        "P66",
        farToday.rows.length === 0 && farTomorrow.rows.length === 1,
        `session zone Kiritimati (current_date ${far}, Bogota ${today}): month task dated today takes another month, rows = ${farToday.rows.length}; dated Bogota-tomorrow rows = ${farTomorrow.rows.length}`,
      );
      await tx`select set_config('TimeZone', 'UTC', true)`;

      const renames = await attempt(
        tx,
        (sp) => sp`update goals.one_offs set name = 'otro' where id = ${onToday}`,
      );
      assert("P64", renames.code === undefined, `update one_offs.name, sqlstate = ${renames.code ?? "none"}`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  // 0011 moved the zone's day rule from the policy into the trigger's body.
  const policies = await sql<{ policyname: string }[]>`
    select policyname from pg_policies
    where schemaname = 'goals' and tablename = 'one_offs' order by policyname`;
  const [guard] = await sql<{ prosrc: string }[]>`
    select prosrc from pg_proc
    where pronamespace = 'goals'::regnamespace and proname = 'one_offs_guard_day'`;
  assert(
    "P65",
    policies.length === 4 &&
      policies.some((p) => p.policyname === "one_offs_update_self") &&
      !!guard &&
      guard.prosrc.includes("America/Bogota") &&
      !guard.prosrc.includes("CURRENT_DATE") &&
      guard.prosrc.includes("IS NULL"),
    `one_offs policies = ${policies.map((p) => p.policyname).join(", ")}; guard trigger names the zone`,
  );

  await sql.end();
}

// The privileges one role holds on one `goals` table, table-level and
// column-level apart, as `PRIV` and `PRIV(col, …)`, sorted.
async function privilegesOf(
  q: postgres.Sql | postgres.TransactionSql,
  table: string,
  grantee: string,
): Promise<string> {
  const tableLevel = await q<{ privilege_type: string }[]>`
    select privilege_type from information_schema.role_table_grants
    where table_schema = 'goals' and table_name = ${table} and grantee = ${grantee}`;
  const columnLevel = await q<{ privilege_type: string; column_name: string }[]>`
    select privilege_type, column_name from information_schema.column_privileges
    where table_schema = 'goals' and table_name = ${table} and grantee = ${grantee}`;
  const whole = new Set(tableLevel.map((r) => r.privilege_type));
  const byColumn = new Map<string, string[]>();
  for (const { privilege_type, column_name } of columnLevel) {
    // A table-level grant shows up on every column too; keep the narrow ones.
    if (whole.has(privilege_type)) continue;
    byColumn.set(privilege_type, [...(byColumn.get(privilege_type) ?? []), column_name]);
  }
  return [
    ...[...whole],
    ...[...byColumn].map(([privilege, columns]) => `${privilege}(${columns.sort().join(",")})`),
  ]
    .sort()
    .join(" ");
}

// What 0007 grants on the three plan tables and on `one_offs`,
// read from the catalogue. Takes any executor so a mutant run can read it
// inside its own rollback.
async function assertPlanByMonthCatalogue(q: postgres.Sql | postgres.TransactionSql): Promise<void> {
  const expected: [string, string, string][] = [
    ["P108", "month_budgets", "DELETE INSERT(amount,goal_id,month,user_id) SELECT UPDATE(amount)"],
    ["P110", "model_calls", "INSERT(model,source,user_id) SELECT UPDATE(input_tokens,outcome,output_tokens)"],
    // 0015 took the UPDATE 0008 gave; 0025 gives back aim and span, and the delete (RP-127).
    ["P113", "phases", "DELETE INSERT(aim,ends_on,goal_id,id,starts_on,user_id) SELECT UPDATE(aim,ends_on,starts_on)"],
  ];
  for (const [label, table, wanted] of expected) {
    const authenticated = await privilegesOf(q, table, "authenticated");
    const anon = await privilegesOf(q, table, "anon");
    const service = await privilegesOf(q, table, "service_role");
    assert(
      label,
      authenticated === wanted && anon === "" && service === "",
      `${table}: authenticated = ${authenticated || "none"}; anon = ${anon || "none"}; service_role = ${service || "none"}`,
    );
  }

  // 0015 dropped the table with its two grants and its two policies.
  const [shifts] = await q<{ gone: boolean }[]>`select to_regclass('goals.month_shifts') is null as gone`;
  assert("P109", shifts.gone, `goals.month_shifts is gone: ${shifts.gone}`);

  const oneOffs = await privilegesOf(q, "one_offs", "authenticated");
  assert(
    "P111",
    oneOffs ===
      "DELETE INSERT(day,estimate,goal_id,id,in_plan,name,note,parent_id,planned_month,position,user_id) SELECT UPDATE(day,estimate,name,note,planned_month)",
    `one_offs: authenticated = ${oneOffs || "none"}`,
  );

  const policies = await q<{ tablename: string; count: number }[]>`
    select tablename, count(*)::int as count from pg_policies
    where schemaname = 'goals' and tablename in ('month_budgets', 'model_calls', 'one_offs', 'phases')
    group by tablename order by tablename`;
  const counts = policies.map((r) => `${r.tablename}=${r.count}`).join(",");
  assert(
    "P112",
    counts === "model_calls=3,month_budgets=4,one_offs=4,phases=4",
    `policies per table = ${counts || "none"}`,
  );
}

// RP-28, RP-30, RP-31, RNP-13: every rule 0007 writes,
// driven bare under a settled session, own transaction, forced rollback. The
// row-to-row rules on `one_offs` and `facts` live in policies alone, so each
// refusal below isolates one clause: the parent differs from a good one in
// one column only.
async function checkPlanByMonth(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");
  const today = todayInZone();

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;

      await enterUserContext(tx, subject);
      const [goal] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon)
        values (${subject}, 'meta', '2027-06-30') returning id`;
      const [otherGoal] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon)
        values (${subject}, 'otra meta', '2027-06-30') returning id`;

      // -- month_budgets --
      const [budget] = await tx<{ id: string }[]>`
        insert into goals.month_budgets (user_id, goal_id, month, amount)
        values (${subject}, ${goal.id}, '2026-10-01', 720) returning id`;
      const ownBudget = await tx<{ id: string }[]>`select id from goals.month_budgets where id = ${budget.id}`;
      assert("P67", ownBudget.length === 1, `own month amount, rows visible = ${ownBudget.length}`);

      const changesAmount = await attemptRows<{ amount: number }>(
        tx,
        (sp) => sp`update goals.month_budgets set amount = 600 where id = ${budget.id} returning amount`,
      );
      assert(
        "P68",
        changesAmount.code === undefined && changesAmount.rows.length === 1 && changesAmount.rows[0].amount === 600,
        `own month amount changes, sqlstate = ${changesAmount.code ?? "none"}, rows = ${changesAmount.rows.length}`,
      );

      const budgetAsOther = await attempt(
        tx,
        (sp) => sp`insert into goals.month_budgets (user_id, goal_id, month, amount)
          values (${intruder}, ${goal.id}, '2026-11-01', 60)`,
      );
      assert(
        "P69",
        budgetAsOther.code === "42501",
        `insert month amount as another user, sqlstate = ${budgetAsOther.code ?? "none"}`,
      );

      const movesMonth = await attempt(
        tx,
        (sp) => sp`update goals.month_budgets set month = '2026-11-01' where id = ${budget.id}`,
      );
      assert("P70", movesMonth.code === "42501", `update month_budgets.month, sqlstate = ${movesMonth.code ?? "none"}`);

      const midMonth = await attempt(
        tx,
        (sp) => sp`insert into goals.month_budgets (user_id, goal_id, month, amount)
          values (${subject}, ${goal.id}, '2026-11-15', 60)`,
      );
      assert("P71", midMonth.code === "23514", `month amount on the 15th, sqlstate = ${midMonth.code ?? "none"}`);

      const negative = await attempt(
        tx,
        (sp) => sp`insert into goals.month_budgets (user_id, goal_id, month, amount)
          values (${subject}, ${goal.id}, '2026-11-01', -1)`,
      );
      assert("P72", negative.code === "23514", `month amount of -1, sqlstate = ${negative.code ?? "none"}`);

      const twice = await attempt(
        tx,
        (sp) => sp`insert into goals.month_budgets (user_id, goal_id, month, amount)
          values (${subject}, ${goal.id}, '2026-10-01', 60)`,
      );
      assert("P73", twice.code === "23505", `second amount for one goal's month, sqlstate = ${twice.code ?? "none"}`);

      await enterUserContext(tx, intruder);
      const foreignBudget = await tx<{ id: string }[]>`select id from goals.month_budgets where id = ${budget.id}`;
      assert("P74", foreignBudget.length === 0, `another person's month amount, rows visible = ${foreignBudget.length}`);
      const foreignAmount = await attemptCount(
        tx,
        (sp) => sp`update goals.month_budgets set amount = 1 where id = ${budget.id}`,
      );
      assert(
        "P75",
        foreignAmount.code === undefined && foreignAmount.count === 0,
        `another person's month amount changes, sqlstate = ${foreignAmount.code ?? "none"}, rows = ${foreignAmount.count}`,
      );
      const foreignDelete = await attemptCount(tx, (sp) => sp`delete from goals.month_budgets where id = ${budget.id}`);
      assert(
        "P76",
        foreignDelete.code === undefined && foreignDelete.count === 0,
        `another person's month amount deleted, sqlstate = ${foreignDelete.code ?? "none"}, rows = ${foreignDelete.count}`,
      );

      await enterUserContext(tx, subject);
      const ownDelete = await attemptCount(tx, (sp) => sp`delete from goals.month_budgets where id = ${budget.id}`);
      assert(
        "P77",
        ownDelete.code === undefined && ownDelete.count === 1,
        `own month amount deleted, sqlstate = ${ownDelete.code ?? "none"}, rows = ${ownDelete.count}`,
      );

      // -- one_offs: sub-tasks, one level deep, under a month task only --
      const monthTask = async (name: string, goalId: string): Promise<string> => {
        const [row] = await tx<{ id: string }[]>`
          insert into goals.one_offs (user_id, goal_id, name, planned_month)
          values (${subject}, ${goalId}, ${name}, '2026-10-01') returning id`;
        return row.id;
      };
      const parent = await monthTask("padre", goal.id);
      const [datedParent] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, day)
        values (${subject}, ${goal.id}, 'padre con dia', '2026-10-05') returning id`;
      const [estimatedParent] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
        values (${subject}, ${goal.id}, 'padre con estimado', '2026-10-01', 60) returning id`;
      const doneParent = await monthTask("padre hecho", goal.id);
      await tx`insert into goals.facts (user_id, one_off_id, day) values (${subject}, ${doneParent}, ${today})`;
      const otherGoalParent = await monthTask("padre de otra meta", otherGoal.id);

      const childUnder = (parentId: string, goalId = goal.id) =>
        attemptRows<{ id: string }>(
          tx,
          (sp) => sp`insert into goals.one_offs (user_id, goal_id, name, parent_id, estimate)
            values (${subject}, ${goalId}, 'hija', ${parentId}, 30) returning id`,
        );

      const child = await childUnder(parent);
      assert(
        "P78",
        child.code === undefined && child.rows.length === 1,
        `sub-task under a month task, sqlstate = ${child.code ?? "none"}`,
      );
      const childId = child.rows[0]?.id ?? randomUUID();

      // One savepoint at a time: never start them together in one transaction.
      const refusals: [string, string, string][] = [
        ["P79", "under a sub-task", childId],
        ["P80", "under a month task with a day", datedParent.id],
        ["P81", "under a month task with an estimate", estimatedParent.id],
        ["P82", "under a month task with a fact", doneParent],
        ["P83", "under a month task of another goal", otherGoalParent],
      ];
      for (const [label, what, parentId] of refusals) {
        const result = await childUnder(parentId);
        assert(label, result.code === "42501", `sub-task ${what}, sqlstate = ${result.code ?? "none (inserted)"}`);
      }

      const childWithMonth = await attempt(
        tx,
        (sp) => sp`insert into goals.one_offs (user_id, goal_id, name, parent_id, planned_month)
          values (${subject}, ${goal.id}, 'hija con mes', ${parent}, '2026-10-01')`,
      );
      assert(
        "P84",
        childWithMonth.code === "23514",
        `sub-task with a month of its own, sqlstate = ${childWithMonth.code ?? "none"}`,
      );

      const parentTakesDay = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.one_offs set day = '2026-10-20' where id = ${parent} returning id`,
      );
      assert(
        "P85",
        parentTakesDay.code === "42501",
        `a parent takes a day, sqlstate = ${parentTakesDay.code ?? "none"}, rows = ${parentTakesDay.rows.length}`,
      );

      const parentMoves = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.one_offs set planned_month = '2026-11-01' where id = ${parent} returning id`,
      );
      assert(
        "P86",
        parentMoves.code === undefined && parentMoves.rows.length === 1,
        `an undone parent moves a month, sqlstate = ${parentMoves.code ?? "none"}, rows = ${parentMoves.rows.length}`,
      );

      const doneLeaf = await monthTask("hecha", goal.id);
      await tx`insert into goals.facts (user_id, one_off_id, day) values (${subject}, ${doneLeaf}, ${today})`;
      const doneMoves = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.one_offs set planned_month = '2026-11-01' where id = ${doneLeaf} returning id`,
      );
      assert(
        "P87",
        doneMoves.code === undefined && doneMoves.rows.length === 0,
        `a done month task moves a month, sqlstate = ${doneMoves.code ?? "none"}, rows = ${doneMoves.rows.length}`,
      );

      const setsEstimate = await attempt(
        tx,
        (sp) => sp`update goals.one_offs set estimate = 90 where id = ${childId}`,
      );
      assert("P88", setsEstimate.code === undefined, `update one_offs.estimate, sqlstate = ${setsEstimate.code ?? "none"}`);
      const setsParent = await attempt(
        tx,
        (sp) => sp`update goals.one_offs set parent_id = null where id = ${childId}`,
      );
      assert("P89", setsParent.code === "42501", `update one_offs.parent_id, sqlstate = ${setsParent.code ?? "none"}`);

      // -- facts: a parent is done by its children alone --
      const parentFact = await attempt(
        tx,
        (sp) => sp`insert into goals.facts (user_id, one_off_id, day) values (${subject}, ${parent}, ${today})`,
      );
      assert("P90", parentFact.code === "42501", `a fact for a parent, sqlstate = ${parentFact.code ?? "none (inserted)"}`);
      const childFact = await attempt(
        tx,
        (sp) => sp`insert into goals.facts (user_id, one_off_id, day) values (${subject}, ${childId}, ${today})`,
      );
      assert("P91", childFact.code === undefined, `a fact for its sub-task, sqlstate = ${childFact.code ?? "none"}`);

      // -- delete: the FK cascade to the children bypasses RLS --
      const parentGoes = await attemptCount(tx, (sp) => sp`delete from goals.one_offs where id = ${parent}`);
      assert(
        "P92",
        parentGoes.code === undefined && parentGoes.count === 0,
        `delete a parent whose sub-task has a fact, sqlstate = ${parentGoes.code ?? "none"}, rows = ${parentGoes.count}`,
      );
      const childFactLeft = await tx<{ id: string }[]>`select id from goals.facts where one_off_id = ${childId}`;
      assert("P93", childFactLeft.length === 1, `the sub-task's fact after it, rows visible = ${childFactLeft.length}`);

      const emptyParent = await monthTask("padre sin hechos", goal.id);
      await childUnder(emptyParent);
      await childUnder(emptyParent);
      const emptyGoes = await attemptCount(tx, (sp) => sp`delete from goals.one_offs where id = ${emptyParent}`);
      const orphans = await tx<{ id: string }[]>`select id from goals.one_offs where parent_id = ${emptyParent}`;
      assert(
        "P94",
        emptyGoes.code === undefined && emptyGoes.count === 1 && orphans.length === 0,
        `delete a parent with undone sub-tasks, rows = ${emptyGoes.count}, sub-tasks left = ${orphans.length}`,
      );

      // -- month_shifts: gone with 0015, every statement finds no table --
      const shiftRead = await attempt(tx, (sp) => sp`select id from goals.month_shifts`);
      assert("P95", shiftRead.code === "42P01", `read a shift, sqlstate = ${shiftRead.code ?? "none"}`);
      const shiftWrite = await attempt(
        tx,
        (sp) => sp`insert into goals.month_shifts (user_id, goal_id, month) values (${subject}, ${goal.id}, '2026-09-01')`,
      );
      assert("P96", shiftWrite.code === "42P01", `write a shift, sqlstate = ${shiftWrite.code ?? "none"}`);

      // -- model_calls: the day is the zone's, and the count never drops --
      const [call] = await tx<{ id: string; day: string }[]>`
        insert into goals.model_calls (user_id, model, source)
        values (${subject}, 'modelo', 'paste') returning id, day::text as day`;
      assert("P100", call.day === today, `a call's day = ${call.day}, Bogota today = ${today}`);

      const answered = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.model_calls set input_tokens = 900, output_tokens = 300, outcome = 'ok'
          where id = ${call.id} returning id`,
      );
      assert(
        "P101",
        answered.code === undefined && answered.rows.length === 1,
        `own call takes its tokens and outcome, sqlstate = ${answered.code ?? "none"}, rows = ${answered.rows.length}`,
      );

      const forgedDay = await attempt(
        tx,
        (sp) => sp`insert into goals.model_calls (user_id, model, source, day)
          values (${subject}, 'modelo', 'paste', '2026-01-01')`,
      );
      assert("P102", forgedDay.code === "42501", `insert a call naming its day, sqlstate = ${forgedDay.code ?? "none"}`);
      const callDelete = await attempt(tx, (sp) => sp`delete from goals.model_calls where id = ${call.id}`);
      assert("P103", callDelete.code === "42501", `delete a call, sqlstate = ${callDelete.code ?? "none"}`);
      const badSource = await attempt(
        tx,
        (sp) => sp`insert into goals.model_calls (user_id, model, source) values (${subject}, 'modelo', 'x')`,
      );
      assert("P104", badSource.code === "23514", `a call from source 'x', sqlstate = ${badSource.code ?? "none"}`);

      // -- phases: 0015 took 0008's UPDATE; 0025 gives back aim and span to the owner (RP-127) --
      const [shiftable] = await tx<{ id: string }[]>`
        insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
        values (${subject}, ${goal.id}, 'fase corrible', '2026-12-01', '2026-12-31') returning id`;
      const phaseMoves = await attemptShape(
        tx,
        (sp) => sp`update goals.phases set starts_on = '2027-01-01', ends_on = '2027-01-31' where id = ${shiftable.id}`,
      );
      assert("P114", phaseMoves.code === undefined && phaseMoves.count === 1, `own phase's dates move, ${shape(phaseMoves)}`);
      const phaseAim = await attemptShape(tx, (sp) => sp`update goals.phases set aim = 'otra' where id = ${shiftable.id}`);
      assert("P115", phaseAim.code === undefined && phaseAim.count === 1, `update phases.aim, ${shape(phaseAim)}`);
      // The span now runs 2027-01-01..2027-01-31: an end before its start is the CHECK's to refuse.
      const phaseBackwards = await attemptShape(
        tx,
        (sp) => sp`update goals.phases set ends_on = '2026-12-31' where id = ${shiftable.id}`,
      );
      assert(
        "P116",
        phaseBackwards.code === "23514" && phaseBackwards.constraint === "phases_ends_on_after_starts_on",
        `a phase's end moves before its start, ${shape(phaseBackwards)}`,
      );

      await enterUserContext(tx, intruder);
      const foreignPhase = await attemptShape(
        tx,
        (sp) => sp`update goals.phases set starts_on = '2027-02-01', ends_on = '2027-02-28' where id = ${shiftable.id}`,
      );
      assert(
        "P117",
        foreignPhase.code === undefined && foreignPhase.count === 0,
        `another person's phase dates move, ${shape(foreignPhase)}`,
      );
      const foreignShift = await attempt(tx, (sp) => sp`select id from goals.month_shifts`);
      assert("P105", foreignShift.code === "42P01", `another person reads a shift, sqlstate = ${foreignShift.code ?? "none"}`);
      const foreignCall = await tx<{ id: string }[]>`select id from goals.model_calls where id = ${call.id}`;
      assert("P106", foreignCall.length === 0, `another person's call, rows visible = ${foreignCall.length}`);
      const foreignAnswer = await attemptCount(
        tx,
        (sp) => sp`update goals.model_calls set outcome = 'failed' where id = ${call.id}`,
      );
      assert(
        "P107",
        foreignAnswer.code === undefined && foreignAnswer.count === 0,
        `another person's call takes an outcome, sqlstate = ${foreignAnswer.code ?? "none"}, rows = ${foreignAnswer.count}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  await assertPlanByMonthCatalogue(sql);

  await sql.end();
}

// RP-38, RP-60, RNP-14, RNP-15: the key and the connection the
// AI door opens with — 0009's grants, policies and four functions, driven as
// the roles that would break them. Own transaction, forced rollback.
// `AI_DOOR_MUTANT_SQL`, when set, runs inside that same transaction before
// anything is read, so a mutant of a policy, a grant or a function is proved
// red without a line of DDL surviving: the rollback takes it back.
function sha256(): Buffer {
  return createHash("sha256").update(randomBytes(32)).digest();
}

async function checkAiDoor(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");
  const mutant = process.env.AI_DOOR_MUTANT_SQL;

  await sql
    .begin(async (tx) => {
      if (mutant) {
        console.log(`MUTANT  ${mutant.replace(/\s+/g, " ").slice(0, 140)}`);
        await tx.unsafe(mutant);
      }
      await tx`insert into auth.users (id, email)
        values (${subject}, ${`${subject}@example.invalid`}), (${intruder}, ${`${intruder}@example.invalid`})`;

      // -- the catalogue --
      const door: [string, string, string][] = [
        [
          "P118",
          "access_tokens",
          "INSERT(hint,name,token_hash,user_id) SELECT(created_at,expires_at,hint,id,kind,last_used_at,name,redirect_uri,revoked_at,user_id) UPDATE(revoked_at)",
        ],
        ["P119", "oauth_clients", "SELECT(client_name,id,redirect_uris)"],
        ["P120", "oauth_codes", "INSERT(client_id,code_challenge,code_hash,redirect_uri,resource,user_id)"],
        ["P121", "oauth_refresh", ""],
      ];
      for (const [label, table, wanted] of door) {
        const authenticated = await privilegesOf(tx, table, "authenticated");
        const anon = await privilegesOf(tx, table, "anon");
        const service = await privilegesOf(tx, table, "service_role");
        assert(
          label,
          authenticated === wanted && anon === "" && service === "",
          `${table}: authenticated = ${authenticated || "none"}; anon = ${anon || "none"}; service_role = ${service || "none"}`,
        );
      }
      const doorPolicies = await tx<{ tablename: string; count: number }[]>`
        select tablename, count(*)::int as count from pg_policies
        where schemaname = 'goals' and tablename in ('access_tokens', 'oauth_clients', 'oauth_codes', 'oauth_refresh')
        group by tablename order by tablename`;
      const doorCounts = doorPolicies.map((r) => `${r.tablename}=${r.count}`).join(",");
      assert(
        "P122",
        doorCounts === "access_tokens=3,oauth_clients=1,oauth_codes=2",
        `policies per table = ${doorCounts || "none"}`,
      );
      const fns = await tx<{ name: string; secdef: boolean; config: string[] | null; auth: boolean; anon: boolean; svc: boolean }[]>`
        select p.proname as name, p.prosecdef as secdef, p.proconfig as config,
          has_function_privilege('authenticated', p.oid, 'execute') as auth,
          has_function_privilege('anon', p.oid, 'execute') as anon,
          has_function_privilege('service_role', p.oid, 'execute') as svc
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'goals'
          and p.proname in ('person_for_token', 'oauth_register_client', 'oauth_exchange_code', 'oauth_refresh_token')
        order by p.proname`;
      const fnShape = fns
        .map((f) => `${f.name}:${f.secdef ? "definer" : "invoker"}:${(f.config ?? []).join("|")}:${f.auth || f.anon || f.svc ? "open" : "closed"}`)
        .join(" ");
      assert(
        "P123",
        fnShape ===
          'oauth_exchange_code:definer:search_path="":closed oauth_refresh_token:definer:search_path="":closed oauth_register_client:definer:search_path="":closed person_for_token:definer:search_path="":closed',
        fnShape || "no functions",
      );

      // A client nobody owns and a second one a code does not name — made by
      // the connection's own role, the only one that may call the function.
      const [{ id: client }] = await tx<{ id: string }[]>`
        select goals.oauth_register_client('Asistente', array['https://a.example.invalid/cb'], null) as id`;
      const [{ id: otherClient }] = await tx<{ id: string }[]>`
        select goals.oauth_register_client('Otro asistente', array['https://b.example.invalid/cb'], null) as id`;

      // -- the subject --
      await enterUserContext(tx, subject);
      const keyHash = sha256();
      const keyHash2 = sha256();
      const own = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`insert into goals.access_tokens (user_id, name, token_hash, hint)
          values (${subject}, 'mi llave', ${keyHash}, 'abcd') returning id`,
      );
      assert("P124", own.code === undefined && own.rows.length === 1, `insert own key, sqlstate = ${own.code ?? "none"}`);
      const keyId = own.rows[0]?.id;
      const [second] = await tx<{ id: string }[]>`
        insert into goals.access_tokens (user_id, name, token_hash, hint)
        values (${subject}, 'otra llave', ${keyHash2}, 'wxyz') returning id`;

      const readOwn = await tx<{ name: string; hint: string; kind: string; revoked_at: Date | null }[]>`
        select id, user_id, kind, name, hint, created_at, last_used_at, expires_at, revoked_at
        from goals.access_tokens where id = ${keyId}`;
      assert(
        "P125",
        readOwn.length === 1 && readOwn[0].name === "mi llave" && readOwn[0].hint === "abcd" && readOwn[0].kind === "personal",
        `own key's columns read back, rows = ${readOwn.length}, kind = ${readOwn[0]?.kind}`,
      );
      const readHash = await attempt(tx, (sp) => sp`select token_hash from goals.access_tokens where id = ${keyId}`);
      assert("P126", readHash.code === "42501", `owner selects token_hash, sqlstate = ${readHash.code ?? "none"}`);
      const readStar = await attempt(tx, (sp) => sp`select * from goals.access_tokens where id = ${keyId}`);
      assert("P127", readStar.code === "42501", `owner selects *, sqlstate = ${readStar.code ?? "none"}`);

      const forgedOwner = await attempt(
        tx,
        (sp) => sp`insert into goals.access_tokens (user_id, name, token_hash, hint)
          values (${intruder}, 'a nombre de otro', ${sha256()}, 'qqqq')`,
      );
      assert("P128", forgedOwner.code === "42501", `insert a key for another person, sqlstate = ${forgedOwner.code ?? "none"}`);
      const forgedKind = await attempt(
        tx,
        (sp) => sp`insert into goals.access_tokens (user_id, kind, name, token_hash)
          values (${subject}, 'oauth', 'conexion falsa', ${sha256()})`,
      );
      assert("P129", forgedKind.code === "42501", `insert a key of kind oauth, sqlstate = ${forgedKind.code ?? "none"}`);
      const rename = await attempt(tx, (sp) => sp`update goals.access_tokens set name = 'otro' where id = ${keyId}`);
      assert("P130", rename.code === "42501", `update a key's name, sqlstate = ${rename.code ?? "none"}`);
      const expiry = await attempt(tx, (sp) => sp`update goals.access_tokens set expires_at = null where id = ${keyId}`);
      assert("P131", expiry.code === "42501", `update a key's expires_at, sqlstate = ${expiry.code ?? "none"}`);

      const revoke = await attemptCount(
        tx,
        (sp) => sp`update goals.access_tokens set revoked_at = now() where id = ${second.id}`,
      );
      assert("P132", revoke.code === undefined && revoke.count === 1, `revoke own key, sqlstate = ${revoke.code ?? "none"}, rows = ${revoke.count}`);
      const unrevoke = await attemptCount(
        tx,
        (sp) => sp`update goals.access_tokens set revoked_at = null where id = ${second.id}`,
      );
      const restamp = await attemptCount(
        tx,
        (sp) => sp`update goals.access_tokens set revoked_at = now() + interval '1 day' where id = ${second.id}`,
      );
      const [stillRevoked] = await tx<{ revoked_at: Date | null; later: boolean }[]>`
        select revoked_at, revoked_at > now() as later from goals.access_tokens where id = ${second.id}`;
      assert(
        "P133",
        unrevoke.count === 0 && restamp.count === 0 && stillRevoked.revoked_at !== null && stillRevoked.later === false,
        `a revoked key is un-revoked / re-dated: rows = ${unrevoke.count}/${restamp.count}, still revoked = ${stillRevoked.revoked_at !== null}`,
      );

      for (const [label, table] of [
        ["P134", "access_tokens"],
        ["P135", "oauth_clients"],
        ["P136", "oauth_codes"],
        ["P137", "oauth_refresh"],
      ] as const) {
        const del = await attempt(tx, (sp) => sp`delete from goals.${sp(table)}`);
        assert(label, del.code === "42501", `delete from ${table}, sqlstate = ${del.code ?? "none"}`);
      }

      const clientRead = await tx<{ id: string; client_name: string }[]>`
        select id, client_name, redirect_uris from goals.oauth_clients where id = ${client}`;
      assert("P138", clientRead.length === 1 && clientRead[0].client_name === "Asistente", `a client's public metadata reads, rows = ${clientRead.length}`);
      const clientUrl = await attempt(tx, (sp) => sp`select metadata_url from goals.oauth_clients`);
      assert("P139", clientUrl.code === "42501", `select oauth_clients.metadata_url, sqlstate = ${clientUrl.code ?? "none"}`);
      const refreshRead = await attempt(tx, (sp) => sp`select 1 from goals.oauth_refresh limit 1`);
      assert("P140", refreshRead.code === "42501", `select oauth_refresh, sqlstate = ${refreshRead.code ?? "none"}`);
      const refreshWrite = await attempt(
        tx,
        (sp) => sp`insert into goals.oauth_refresh (access_token_id, client_id, refresh_hash)
          values (${keyId}, ${client}, ${sha256()})`,
      );
      assert("P141", refreshWrite.code === "42501", `insert oauth_refresh, sqlstate = ${refreshWrite.code ?? "none"}`);
      const codeRead = await attempt(tx, (sp) => sp`select 1 from goals.oauth_codes limit 1`);
      assert("P142", codeRead.code === "42501", `select oauth_codes, sqlstate = ${codeRead.code ?? "none"}`);

      const ownCode = await attempt(
        tx,
        (sp) => sp`insert into goals.oauth_codes (user_id, client_id, code_hash, code_challenge, redirect_uri, resource)
          values (${subject}, ${client}, ${sha256()}, 'c', 'https://a.example.invalid/cb', 'https://r.example.invalid')`,
      );
      assert("P143", ownCode.code === undefined, `insert own code, sqlstate = ${ownCode.code ?? "none"}`);
      const foreignCode = await attempt(
        tx,
        (sp) => sp`insert into goals.oauth_codes (user_id, client_id, code_hash, code_challenge, redirect_uri, resource)
          values (${intruder}, ${client}, ${sha256()}, 'c', 'https://a.example.invalid/cb', 'https://r.example.invalid')`,
      );
      assert("P144", foreignCode.code === "42501", `insert a code for another person, sqlstate = ${foreignCode.code ?? "none"}`);

      // The four functions answer to the connection's role and to no app role.
      const probe: [string, (sp: postgres.TransactionSql) => Promise<unknown>][] = [
        ["person_for_token", (sp) => sp`select * from goals.person_for_token(${keyHash}::bytea)`],
        [
          "oauth_register_client",
          (sp) => sp`select goals.oauth_register_client('x', array['https://x.example.invalid'], null)`,
        ],
        [
          "oauth_exchange_code",
          (sp) => sp`select goals.oauth_exchange_code(${sha256()}::bytea, 'c', ${client}::uuid, 'r', ${sha256()}::bytea, ${sha256()}::bytea)`,
        ],
        [
          "oauth_refresh_token",
          (sp) => sp`select goals.oauth_refresh_token(${sha256()}::bytea, ${client}::uuid, ${sha256()}::bytea, ${sha256()}::bytea)`,
        ],
      ];
      const asAuthenticated: string[] = [];
      for (const [name, call] of probe) asAuthenticated.push(`${name}=${(await attempt(tx, call)).code ?? "ran"}`);
      assert(
        "P145",
        asAuthenticated.every((r) => r.endsWith("=42501")),
        `authenticated calls ${asAuthenticated.join(" ")}`,
      );

      // -- the intruder --
      await enterUserContext(tx, intruder);
      const foreignKey = await tx<{ id: string }[]>`select id from goals.access_tokens where id = ${keyId}`;
      const foreignAll = await tx<{ id: string }[]>`select id from goals.access_tokens where user_id = ${subject}`;
      assert("P146", foreignKey.length === 0 && foreignAll.length === 0, `another person's keys, rows visible = ${foreignKey.length}/${foreignAll.length}`);
      const foreignRevoke = await attemptCount(
        tx,
        (sp) => sp`update goals.access_tokens set revoked_at = now() where id = ${keyId}`,
      );
      assert(
        "P147",
        foreignRevoke.code === undefined && foreignRevoke.count === 0,
        `revoke another person's key, sqlstate = ${foreignRevoke.code ?? "none"}, rows = ${foreignRevoke.count}`,
      );

      // -- anon --
      await tx`reset role`;
      await tx`select set_config('role', 'anon', true)`;
      const anonRefusals: string[] = [];
      for (const [name, call] of [
        ["select", (sp: postgres.TransactionSql) => sp`select 1 from goals.access_tokens limit 1`],
        ["insert", (sp: postgres.TransactionSql) => sp`insert into goals.access_tokens (user_id, name, token_hash) values (${subject}, 'x', ${sha256()})`],
        ["update", (sp: postgres.TransactionSql) => sp`update goals.access_tokens set revoked_at = now()`],
        ["delete", (sp: postgres.TransactionSql) => sp`delete from goals.access_tokens`],
        ["clients", (sp: postgres.TransactionSql) => sp`select 1 from goals.oauth_clients limit 1`],
        ["codes", (sp: postgres.TransactionSql) => sp`select 1 from goals.oauth_codes limit 1`],
        ["refresh", (sp: postgres.TransactionSql) => sp`select 1 from goals.oauth_refresh limit 1`],
        ...probe,
      ] as [string, (sp: postgres.TransactionSql) => Promise<unknown>][]) {
        anonRefusals.push(`${name}=${(await attempt(tx, call)).code ?? "ran"}`);
      }
      assert("P148", anonRefusals.every((r) => r.endsWith("=42501")), `anon: ${anonRefusals.join(" ")}`);

      // -- the connection's own role: person_for_token --
      await tx`reset role`;
      const person = await tx<{ user_id: string; email: string }[]>`
        select * from goals.person_for_token(${keyHash}::bytea)`;
      assert(
        "P149",
        person.length === 1 && person[0].user_id === subject && person[0].email === `${subject}@example.invalid`,
        `a live key's person, rows = ${person.length}`,
      );
      const [stamp] = await tx<{ last_used_at: Date | null }[]>`
        select last_used_at from goals.access_tokens where id = ${keyId}`;
      assert("P150", stamp.last_used_at !== null, `a resolved key is stamped, last_used_at = ${stamp.last_used_at}`);
      const revokedKey = await tx<{ user_id: string }[]>`select * from goals.person_for_token(${keyHash2}::bytea)`;
      const [revokedStamp] = await tx<{ last_used_at: Date | null }[]>`
        select last_used_at from goals.access_tokens where id = ${second.id}`;
      assert(
        "P151",
        revokedKey.length === 0 && revokedStamp.last_used_at === null,
        `a revoked key resolves to ${revokedKey.length} people, stamped = ${revokedStamp.last_used_at !== null}`,
      );
      const staleHash = sha256();
      const freshHash = sha256();
      await tx`insert into goals.access_tokens (user_id, kind, name, token_hash, expires_at)
        values (${subject}, 'oauth', 'vencida', ${staleHash}, now() - interval '1 minute'),
               (${subject}, 'oauth', 'vigente', ${freshHash}, now() + interval '1 hour')`;
      const stale = await tx<{ user_id: string }[]>`select * from goals.person_for_token(${staleHash}::bytea)`;
      const fresh = await tx<{ user_id: string }[]>`select * from goals.person_for_token(${freshHash}::bytea)`;
      assert(
        "P152",
        stale.length === 0 && fresh.length === 1 && fresh[0].user_id === subject,
        `an expired connection resolves to ${stale.length}, an unexpired one to ${fresh.length}`,
      );
      const unknown = await tx<{ user_id: string }[]>`select * from goals.person_for_token(${sha256()}::bytea)`;
      assert("P153", unknown.length === 0, `an unknown key resolves to ${unknown.length} people`);

      // -- oauth_exchange_code --
      const redirect = "https://a.example.invalid/cb";
      const newCode = async (expired = false): Promise<Buffer> => {
        const hash = sha256();
        await tx`insert into goals.oauth_codes (user_id, client_id, code_hash, code_challenge, redirect_uri, resource, expires_at)
          values (${subject}, ${client}, ${hash}, 'desafio', ${redirect}, 'https://r.example.invalid',
            ${expired ? tx`now() - interval '1 minute'` : tx`now() + interval '10 minutes'`})`;
        return hash;
      };
      const exchange = async (
        code: Buffer,
        o: { challenge?: string; client?: string; redirect?: string; access?: Buffer; refresh?: Buffer } = {},
      ): Promise<string | null> => {
        const [row] = await tx<{ person: string | null }[]>`
          select goals.oauth_exchange_code(${code}::bytea, ${o.challenge ?? "desafio"}, ${(o.client ?? client)}::uuid,
            ${o.redirect ?? redirect}, ${(o.access ?? sha256())}::bytea, ${(o.refresh ?? sha256())}::bytea) as person`;
        return row.person;
      };
      const resolves = async (hash: Buffer): Promise<boolean> =>
        (await tx`select * from goals.person_for_token(${hash}::bytea)`).length === 1;

      const code = await newCode();
      const wrong = [
        await exchange(code, { challenge: "otro" }),
        await exchange(code, { client: otherClient }),
        await exchange(code, { redirect: "https://evil.example.invalid/cb" }),
      ];
      assert("P154", wrong.every((r) => r === null), `a code with a wrong challenge, client or redirect yields ${wrong.join(",")}`);
      const access1 = sha256();
      const refresh1 = sha256();
      const once = await exchange(code, { access: access1, refresh: refresh1 });
      assert("P155", once === subject && (await resolves(access1)), `the matching code yields the person, got ${once}`);
      // Inside 30 s a second redemption is a retry and spares; past it, a replay and revokes (Q22 a).
      const access1b = sha256();
      const twice = await exchange(code, { access: access1b });
      const spared = (await resolves(access1)) && !(await resolves(access1b));
      await tx`update goals.oauth_codes set used_at = now() - interval '31 seconds' where code_hash = ${code}`;
      const late = await exchange(code, { access: sha256() });
      assert(
        "P156",
        twice === null && spared && late === null && !(await resolves(access1)),
        `a second redemption yields ${twice} and spares = ${spared}; past 30 s yields ${late}, the connection still resolves = ${await resolves(access1)}`,
      );
      const stale2 = await newCode(true);
      const expiredToken = sha256();
      const expired = await exchange(stale2, { access: expiredToken });
      assert("P157", expired === null && !(await resolves(expiredToken)), `an expired code yields ${expired}`);

      // -- oauth_refresh_token --
      const code2 = await newCode();
      const access2 = sha256();
      const refreshA = sha256();
      await exchange(code2, { access: access2, refresh: refreshA });
      const rotate = async (old: Buffer, access: Buffer, refresh: Buffer, forClient = client): Promise<string | null> => {
        const [row] = await tx<{ person: string | null }[]>`
          select goals.oauth_refresh_token(${old}::bytea, ${forClient}::uuid, ${access}::bytea, ${refresh}::bytea) as person`;
        return row.person;
      };
      const wrongClient = await rotate(refreshA, sha256(), sha256(), otherClient);
      const access3 = sha256();
      const refreshB = sha256();
      const rotated = await rotate(refreshA, access3, refreshB);
      assert(
        "P158",
        wrongClient === null && rotated === subject && (await resolves(access3)) && !(await resolves(access2)),
        `a refresh rotates once: wrong client ${wrongClient}, rotated ${rotated}, old key still resolves = ${await resolves(access2)}`,
      );
      const replay = await rotate(refreshA, sha256(), sha256());
      const kept = await resolves(access3);
      await tx`update goals.oauth_refresh set used_at = now() - interval '31 seconds' where refresh_hash = ${refreshA}`;
      const lateReplay = await rotate(refreshA, sha256(), sha256());
      assert(
        "P159",
        replay === null && kept && lateReplay === null && !(await resolves(access3)),
        `a reused refresh yields ${replay} and keeps = ${kept}; past 30 s yields ${lateReplay}, the connection still resolves = ${await resolves(access3)}`,
      );

      // -- a replay revokes the replayed connection and no other of the same person --
      const connect = async (): Promise<{ access: Buffer; refresh: Buffer; code: Buffer }> => {
        const code = await newCode();
        const access = sha256();
        const refresh = sha256();
        await exchange(code, { access, refresh });
        return { access, refresh, code };
      };
      const ageRefresh = (hash: Buffer, seconds: number) =>
        tx`update goals.oauth_refresh set used_at = now() - ${seconds} * interval '1 second' where refresh_hash = ${hash}`;
      const ageCode = (hash: Buffer, seconds: number) =>
        tx`update goals.oauth_codes set used_at = now() - ${seconds} * interval '1 second' where code_hash = ${hash}`;

      const rA = await connect();
      const rB = await connect();
      const rotatedA = sha256();
      await rotate(rA.refresh, rotatedA, sha256());
      await ageRefresh(rA.refresh, 29);
      const refresh29 = await rotate(rA.refresh, sha256(), sha256());
      const spared29 = await resolves(rotatedA);
      await ageRefresh(rA.refresh, 31);
      const refresh31 = await rotate(rA.refresh, sha256(), sha256());
      assert(
        "P303",
        refresh29 === null && spared29 && refresh31 === null && !(await resolves(rotatedA)) && (await resolves(rB.access)),
        `refresh replay: at 29 s yields ${refresh29} and spares = ${spared29}; at 31 s yields ${refresh31}, replayed connection resolves = ${await resolves(rotatedA)}, the person's other connection resolves = ${await resolves(rB.access)}`,
      );

      const cA = await connect();
      const cB = await connect();
      await ageCode(cA.code, 29);
      const code29 = await exchange(cA.code, { access: sha256() });
      const codeSpared29 = await resolves(cA.access);
      await ageCode(cA.code, 31);
      const code31 = await exchange(cA.code, { access: sha256() });
      assert(
        "P304",
        code29 === null && codeSpared29 && code31 === null && !(await resolves(cA.access)) && (await resolves(cB.access)),
        `code replay: at 29 s yields ${code29} and spares = ${codeSpared29}; at 31 s yields ${code31}, replayed connection resolves = ${await resolves(cA.access)}, the person's other connection resolves = ${await resolves(cB.access)}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  await sql.end();
}

// RP-45: `0011` adds `note`, loosens `one_offs_update_self` to the
// own row and moves RP-59's day/month rule into the `one_offs_guard_day`
// trigger, which skips the row. Driven bare under a settled session.
async function checkTaskNote(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;

      await enterUserContext(tx, subject);
      const [goal] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon)
        values (${subject}, 'meta', '2027-12-31') returning id`;
      const [done] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, name) values (${subject}, 'hecha') returning id`;
      await tx`insert into goals.facts (user_id, one_off_id, day) values (${subject}, ${done.id}, '2026-09-22')`;
      const [doneTask] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, planned_month)
        values (${subject}, ${goal.id}, 'tarea hecha', '2026-11-01') returning id`;
      await tx`insert into goals.facts (user_id, one_off_id, day) values (${subject}, ${doneTask.id}, '2026-09-22')`;
      const [today] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, name, day) values (${subject}, 'de hoy', ${todayInZone()}) returning id`;
      const [past] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, name, day) values (${subject}, 'pasada', ${dayAfter(todayInZone(), -3)}) returning id`;

      await enterUserContext(tx, intruder);
      const [theirs] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, name) values (${intruder}, 'ajeno') returning id`;

      await enterUserContext(tx, subject);

      const doneNote = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.one_offs set note = 'una nota' where id = ${done.id} returning id`,
      );
      assert(
        "P160",
        doneNote.code === undefined && doneNote.rows.length === 1,
        `own done one-off takes a note, sqlstate = ${doneNote.code ?? "none"}, rows = ${doneNote.rows.length}`,
      );

      const todayNote = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.one_offs set note = 'otra' where id = ${today.id} returning id`,
      );
      assert(
        "P161",
        todayNote.code === undefined && todayNote.rows.length === 1,
        `own one-off dated today takes a note, sqlstate = ${todayNote.code ?? "none"}, rows = ${todayNote.rows.length}`,
      );

      const doneDay = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.one_offs set day = ${dayAfter(todayInZone(), 5)} where id = ${done.id} returning id`,
      );
      assert(
        "P162",
        doneDay.code === undefined && doneDay.rows.length === 0,
        `done one-off refuses a day, sqlstate = ${doneDay.code ?? "none"}, rows = ${doneDay.rows.length}`,
      );

      const doneMonth = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.one_offs set planned_month = '2026-12-01' where id = ${doneTask.id} returning id`,
      );
      assert(
        "P163",
        doneMonth.code === undefined && doneMonth.rows.length === 0,
        `done task takes another month, sqlstate = ${doneMonth.code ?? "none"}, rows = ${doneMonth.rows.length}`,
      );

      const pastDay = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.one_offs set day = ${dayAfter(todayInZone(), 5)} where id = ${past.id} returning id`,
      );
      assert(
        "P164",
        pastDay.code === undefined && pastDay.rows.length === 1,
        `past-dated one-off with no fact takes a day, sqlstate = ${pastDay.code ?? "none"}, rows = ${pastDay.rows.length}`,
      );

      const foreignNote = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.one_offs set note = 'ajena' where id = ${theirs.id} returning id`,
      );
      assert(
        "P165",
        foreignNote.code === undefined && foreignNote.rows.length === 0,
        `another person's one-off takes a note, sqlstate = ${foreignNote.code ?? "none"}, rows = ${foreignNote.rows.length}`,
      );

      const empty = await attempt(
        tx,
        (sp) => sp`update goals.one_offs set note = '' where id = ${done.id}`,
      );
      assert("P166", empty.code === "23514", `note = '' , sqlstate = ${empty.code ?? "none"}`);

      const blank = await attempt(
        tx,
        (sp) => sp`update goals.one_offs set note = E'  \n ' where id = ${done.id}`,
      );
      assert("P167", blank.code === "23514", `note of whitespace, sqlstate = ${blank.code ?? "none"}`);

      const long = await attempt(
        tx,
        (sp) => sp`update goals.one_offs set note = ${"x".repeat(2001)} where id = ${done.id}`,
      );
      assert("P168", long.code === "23514", `note of 2001 characters, sqlstate = ${long.code ?? "none"}`);

      const exact = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.one_offs set note = ${"x".repeat(2000)} where id = ${done.id} returning id`,
      );
      assert(
        "P169",
        exact.code === undefined && exact.rows.length === 1,
        `note of 2000 characters, sqlstate = ${exact.code ?? "none"}, rows = ${exact.rows.length}`,
      );

      const cleared = await attemptRows<{ note: string | null }>(
        tx,
        (sp) => sp`update goals.one_offs set note = null where id = ${done.id} returning note`,
      );
      assert(
        "P170",
        cleared.code === undefined && cleared.rows.length === 1 && cleared.rows[0].note === null,
        `note emptied reads null, sqlstate = ${cleared.code ?? "none"}, rows = ${cleared.rows.length}`,
      );

      const insertNote = await attemptRows<{ note: string | null }>(
        tx,
        (sp) => sp`insert into goals.one_offs (user_id, name, note) values (${subject}, 'con nota', 'hola') returning note`,
      );
      assert(
        "P171",
        insertNote.code === undefined && insertNote.rows[0]?.note === "hola",
        `insert with a note, sqlstate = ${insertNote.code ?? "none"}`,
      );

      const renames = await attempt(
        tx,
        (sp) => sp`update goals.one_offs set name = 'otro' where id = ${done.id}`,
      );
      assert("P172", renames.code === undefined, `update one_offs.name, sqlstate = ${renames.code ?? "none"}`);

      await tx`select set_config('role', 'anon', true)`;
      const anonNote = await attempt(
        tx,
        (sp) => sp`update goals.one_offs set note = 'anon' where id = ${done.id}`,
      );
      assert("P173", anonNote.code === "42501", `anon update note, sqlstate = ${anonNote.code ?? "none"}`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  await sql.end();
}

// RP-47: the plan's order is written at insert by a trigger and no act changes it.
async function checkPlanOrder(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;

      await enterUserContext(tx, intruder);
      await tx`insert into goals.goals (user_id, name, horizon, position) values (${intruder}, 'ajena', '2027-12-31', 40)`;
      await tx`insert into goals.one_offs (user_id, name, position) values (${intruder}, 'ajena', 40)`;

      await enterUserContext(tx, subject);
      const [g1] = await tx<{ id: string; position: number }[]>`
        insert into goals.goals (user_id, name, horizon) values (${subject}, 'uno', '2027-12-31') returning id, position`;
      const [g2] = await tx<{ id: string; position: number }[]>`
        insert into goals.goals (user_id, name, horizon) values (${subject}, 'dos', '2027-12-31') returning id, position`;
      assert(
        "P174",
        g1.position === 1 && g2.position === 2,
        `goals with no position land at max + 1 per person, got ${g1.position}, ${g2.position}`,
      );

      const [named] = await tx<{ position: number }[]>`
        insert into goals.goals (user_id, name, horizon, position) values (${subject}, 'tres', '2027-12-31', 10) returning position`;
      assert("P175", named.position === 10, `an insert naming a position keeps it, got ${named.position}`);

      const [after] = await tx<{ position: number }[]>`
        insert into goals.goals (user_id, name, horizon) values (${subject}, 'cuatro', '2027-12-31') returning position`;
      assert("P176", after.position === 11, `max + 1 after a named position, got ${after.position}`);

      const [o1] = await tx<{ id: string; position: number }[]>`
        insert into goals.one_offs (user_id, name) values (${subject}, 'a') returning id, position`;
      assert("P177", o1.position === 1, `intruder's one-off at 40 does not move my max, got ${o1.position}`);

      const many = await tx<{ name: string; position: number }[]>`
        insert into goals.one_offs (user_id, name) values (${subject}, 'b'), (${subject}, 'c') returning name, position`;
      assert(
        "P178",
        many.map((r) => r.position).join() === "2,3",
        `one statement, two rows, takes consecutive positions, got ${many.map((r) => r.position).join()}`,
      );

      const [c1] = await tx<{ id: string; position: number }[]>`
        insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
        values (${subject}, ${g1.id}, 'diario', 'daily', 'tap') returning id, position`;
      const [c2] = await tx<{ position: number }[]>`
        insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
        values (${subject}, ${g1.id}, 'otro', 'daily', 'tap') returning position`;
      assert("P179", c1.position === 1 && c2.position === 2, `commitments fill too, got ${c1.position}, ${c2.position}`);

      const same = await tx<{ name: string; position: number }[]>`
        insert into goals.one_offs (user_id, name) values (${subject}, 'Cap. 2'), (${subject}, 'Cap. 1') returning name, position`;
      assert(
        "P180",
        same[0].position < same[1].position,
        `one statement, two rows: arrival order is kept by an insert, got ${same.map((r) => `${r.name}=${r.position}`).join()}`,
      );

      const moveGoal = await attempt(tx, (sp) => sp`update goals.goals set position = 99 where id = ${g1.id}`);
      assert("P181", moveGoal.code === "42501", `update goals.position, sqlstate = ${moveGoal.code ?? "none"}`);
      const moveOne = await attempt(tx, (sp) => sp`update goals.one_offs set position = 99 where id = ${o1.id}`);
      assert("P182", moveOne.code === "42501", `update one_offs.position, sqlstate = ${moveOne.code ?? "none"}`);
      const moveCommitment = await attempt(tx, (sp) => sp`update goals.commitments set position = 99 where id = ${c1.id}`);
      assert("P183", moveCommitment.code === "42501", `update commitments.position, sqlstate = ${moveCommitment.code ?? "none"}`);

      const [{ nulls }] = await tx<{ nulls: number }[]>`
        select (select count(*) from goals.goals where position is null)
             + (select count(*) from goals.one_offs where position is null)
             + (select count(*) from goals.commitments where position is null) as nulls`;
      assert("P184", Number(nulls) === 0, `no row without a position, got ${nulls}`);

      await tx`select set_config('role', 'anon', true)`;
      const anonInsert = await attempt(
        tx,
        (sp) => sp`insert into goals.one_offs (user_id, name, position) values (${subject}, 'anon', 5)`,
      );
      assert("P185", anonInsert.code === "42501", `anon insert naming position, sqlstate = ${anonInsert.code ?? "none"}`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  await sql.end();
}

// RP-47: the backfill's tie-break, run over a fixture; the expression is the 0012 one.
async function checkPlanOrderBackfillTieBreak(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const rows = await sql<{ name: string; rn: number }[]>`
    select name, row_number() over (
      partition by user_id
      order by created_at, substring(name from '\\d+')::numeric nulls last, name, id
    ) as rn
    from (values
      ('00000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-0000000000aa'::uuid, '2026-01-01T00:00:00Z'::timestamptz, 'Cap. 10'),
      ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-0000000000aa'::uuid, '2026-01-01T00:00:00Z'::timestamptz, 'Cap. 2'),
      ('00000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-0000000000aa'::uuid, '2026-01-01T00:00:00Z'::timestamptz, 'Cap. 1')
    ) as t (id, user_id, created_at, name)
    order by rn`;
  assert(
    "P186",
    rows.map((r) => r.name).join("|") === "Cap. 1|Cap. 2|Cap. 10",
    `backfill with equal created_at orders by the number in the name, got ${rows.map((r) => r.name).join("|")}`,
  );
  await sql.end();
}

// RP-47: the commitments trigger takes its max per person. Runs with no RLS, the only caller that sees another person's rows.
async function checkCommitmentPositionPerPerson(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;

      const [ig] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${intruder}, 'ajena', '2027-12-31') returning id`;
      await tx`
        insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, position)
        values (${intruder}, ${ig.id}, 'ajeno', 'daily', 'tap', 40)`;

      const [sg] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${subject}, 'mia', '2027-12-31') returning id`;
      const [first] = await tx<{ position: number }[]>`
        insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
        values (${subject}, ${sg.id}, 'primero', 'daily', 'tap') returning position`;
      assert(
        "P187",
        first.position === 1,
        `intruder's commitment at 40 does not move my first commitment, got ${first.position}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  await sql.end();
}

// RP-47: the goals and one_offs triggers take their max per person, run with no RLS.
async function checkGoalAndOneOffPositionPerPerson(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;
      await tx`insert into goals.goals (user_id, name, horizon, position) values (${intruder}, 'ajena', '2027-12-31', 40)`;
      await tx`insert into goals.one_offs (user_id, name, position) values (${intruder}, 'ajena', 40)`;

      const [goal] = await tx<{ position: number }[]>`
        insert into goals.goals (user_id, name, horizon) values (${subject}, 'mia', '2027-12-31') returning position`;
      assert("P188", goal.position === 1, `intruder's goal at 40 does not move my first goal, got ${goal.position}`);

      const [oneOff] = await tx<{ position: number }[]>`
        insert into goals.one_offs (user_id, name) values (${subject}, 'mia') returning position`;
      assert("P189", oneOff.position === 1, `intruder's one-off at 40 does not move my first one-off, got ${oneOff.position}`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  await sql.end();
}

// RP-50 to RP-55: `0013` flags plan tasks, grants `name` and
// `estimate` an UPDATE guarded by `one_offs_guard_day`, and adds `rhythm` and
// `plan_seen` to goals. Driven bare, own transaction, forced rollback.
async function checkRoadmapSchema(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;
      const [bare] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${subject}, 'sin medida', '2027-12-31') returning id`;
      const [measured] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, measure_name, measure_unit)
        values (${subject}, 'con medida', '2027-12-31', 'horas', 'h') returning id`;
      const [theirGoal] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${intruder}, 'ajena', '2027-12-31') returning id`;
      const [theirs] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, planned_month) values (${intruder}, ${theirGoal.id}, 'ajena', '2026-11-01') returning id`;

      await enterUserContext(tx, subject);
      const [fixed] = await tx<{ id: string; in_plan: boolean }[]>`
        insert into goals.one_offs (user_id, goal_id, name, planned_month)
        values (${subject}, ${measured.id}, 'fijada', '2026-11-01') returning id, in_plan`;
      assert("P190", fixed.in_plan === true, `insert naming planned_month lands in_plan, got ${fixed.in_plan}`);

      const [suelta] = await tx<{ id: string; in_plan: boolean }[]>`
        insert into goals.one_offs (user_id, goal_id, name, day)
        values (${subject}, ${measured.id}, 'suelta', current_date + 1) returning id, in_plan`;
      assert("P191", suelta.in_plan === false, `insert with neither month nor parent stays out, got ${suelta.in_plan}`);

      const [unfixed] = await tx<{ id: string; in_plan: boolean }[]>`
        insert into goals.one_offs (user_id, goal_id, name, in_plan)
        values (${subject}, ${measured.id}, 'colocada', true) returning id, in_plan`;
      assert("P192", unfixed.in_plan === true, `insert naming in_plan keeps it, got ${unfixed.in_plan}`);

      const underUnfixed = await attemptRows<{ id: string; in_plan: boolean }>(
        tx,
        (sp) => sp`insert into goals.one_offs (user_id, goal_id, name, parent_id)
          values (${subject}, ${measured.id}, 'hija', ${unfixed.id}) returning id, in_plan`,
      );
      assert(
        "P193",
        underUnfixed.code === undefined && underUnfixed.rows[0]?.in_plan === true,
        `sub-task under an unfixed plan task is admitted and in plan, sqlstate = ${underUnfixed.code ?? "none"}`,
      );

      const underSuelta = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`insert into goals.one_offs (user_id, goal_id, name, parent_id)
          values (${subject}, ${measured.id}, 'hija de suelta', ${suelta.id}) returning id`,
      );
      assert("P194", underSuelta.code === "42501", `sub-task under a suelta, sqlstate = ${underSuelta.code ?? "none"}`);

      // A plan task may take a day (scheduleOneOff); only a goalless one is out of the plan.
      const goallessInPlan = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`insert into goals.one_offs (user_id, name, in_plan)
          values (${subject}, 'sin meta', true) returning id`,
      );
      assert("P195", goallessInPlan.code === "23514", `in_plan with no goal, sqlstate = ${goallessInPlan.code ?? "none"}`);

      const [done] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, planned_month)
        values (${subject}, ${measured.id}, 'hecha', '2026-11-01') returning id`;
      await tx`insert into goals.facts (user_id, one_off_id, day) values (${subject}, ${done.id}, '2026-09-22')`;

      const renamed = await attemptRows<{ name: string }>(
        tx,
        (sp) => sp`update goals.one_offs set name = 'nueva' where id = ${fixed.id} returning name`,
      );
      assert(
        "P196",
        renamed.code === undefined && renamed.rows.length === 1 && renamed.rows[0].name === "nueva",
        `own undone task takes a name, sqlstate = ${renamed.code ?? "none"}, rows = ${renamed.rows.length}`,
      );

      const reestimated = await attemptRows<{ estimate: number }>(
        tx,
        (sp) => sp`update goals.one_offs set estimate = 3 where id = ${fixed.id} returning estimate`,
      );
      assert(
        "P197",
        reestimated.code === undefined && reestimated.rows.length === 1 && reestimated.rows[0].estimate === 3,
        `own undone task takes an estimate, sqlstate = ${reestimated.code ?? "none"}, rows = ${reestimated.rows.length}`,
      );

      const doneEstimate = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.one_offs set estimate = 4 where id = ${done.id} returning id`,
      );
      assert(
        "P198",
        doneEstimate.code === undefined && doneEstimate.rows.length === 0,
        `estimate on a done task, sqlstate = ${doneEstimate.code ?? "none"}, rows = ${doneEstimate.rows.length}`,
      );

      const parentEstimate = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.one_offs set estimate = 4 where id = ${unfixed.id} returning id`,
      );
      assert(
        "P199",
        parentEstimate.code === undefined && parentEstimate.rows.length === 0,
        `estimate on a parent, sqlstate = ${parentEstimate.code ?? "none"}, rows = ${parentEstimate.rows.length}`,
      );

      const doneName = await attemptRows<{ name: string }>(
        tx,
        (sp) => sp`update goals.one_offs set name = 'hecha y renombrada' where id = ${done.id} returning name`,
      );
      assert(
        "P200",
        doneName.code === undefined && doneName.rows.length === 1,
        `name on a done task, sqlstate = ${doneName.code ?? "none"}, rows = ${doneName.rows.length}`,
      );

      const theirName = await attemptCount(
        tx,
        (sp) => sp`update goals.one_offs set name = 'robada', estimate = 2 where id = ${theirs.id}`,
      );
      assert("P201", theirName.code === undefined && theirName.count === 0, `another person's row, sqlstate = ${theirName.code ?? "none"}, count = ${theirName.count}`);

      const flip = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.one_offs set in_plan = true where id = ${suelta.id} returning id`,
      );
      assert("P202", flip.code === "42501", `update one_offs.in_plan, sqlstate = ${flip.code ?? "none"}`);

      const bareRhythm = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.goals set rhythm = 5 where id = ${bare.id} returning id`,
      );
      assert("P203", bareRhythm.code === "23514", `rhythm on a goal with no measure, sqlstate = ${bareRhythm.code ?? "none"}`);

      const rhythm = await attemptRows<{ rhythm: number }>(
        tx,
        (sp) => sp`update goals.goals set rhythm = 5 where id = ${measured.id} returning rhythm`,
      );
      assert("P204", rhythm.code === undefined && rhythm.rows[0]?.rhythm === 5, `rhythm on a measured goal, sqlstate = ${rhythm.code ?? "none"}`);

      const badSeen = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.goals set plan_seen = '2026-11-15' where id = ${measured.id} returning id`,
      );
      assert("P205", badSeen.code === "23514", `plan_seen off the first day, sqlstate = ${badSeen.code ?? "none"}`);

      const seen = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`update goals.goals set plan_seen = '2026-11-01' where id = ${measured.id} returning id`,
      );
      assert("P206", seen.code === undefined && seen.rows.length === 1, `plan_seen on the first day, sqlstate = ${seen.code ?? "none"}`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  // The data move: nothing with a month or a parent is left outside the plan.
  const [{ n }] = await sql<{ n: string }[]>`
    select count(*)::text as n from goals.one_offs
    where (planned_month is not null or parent_id is not null) and not in_plan`;
  assert("P207", Number(n) === 0, `rows with a month or a parent outside the plan, got ${n}`);

  await sql.end();
}

// RP-19, RP-22, RP-38, RP-60, RNP-19: what 0015 leaves, read from
// the catalogue and driven as `authenticated`. Own transaction, forced rollback.
async function checkAuditoria0015(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      const [index] = await tx<{ def: string }[]>`
        select indexdef as def from pg_indexes
        where schemaname = 'goals' and tablename = 'facts' and indexname = 'facts_one_off_unique'`;
      assert(
        "P208",
        !!index && index.def.includes("UNIQUE") && index.def.includes("(one_off_id)") && index.def.includes("one_off_id IS NOT NULL"),
        `facts_one_off_unique = ${index?.def ?? "missing"}`,
      );

      // 0015 dropped these for want of a grant; 0025 gives the grant and brings them back (RP-127).
      const deletes = await tx<{ policyname: string }[]>`
        select policyname from pg_policies
        where schemaname = 'goals' and policyname in ('goals_delete_self', 'commitments_delete_self', 'phases_delete_self', 'phases_update_self')
        order by policyname`;
      const names = deletes.map((r) => r.policyname).join(",");
      assert(
        "P209",
        names === "commitments_delete_self,goals_delete_self,phases_delete_self,phases_update_self",
        `delete and phase-update policies = ${names || "none"}`,
      );

      const fns = await tx<{ name: string; src: string; secdef: boolean; config: string[] | null; auth: boolean; anon: boolean; svc: boolean }[]>`
        select p.proname as name, p.prosrc as src, p.prosecdef as secdef, p.proconfig as config,
          has_function_privilege('authenticated', p.oid, 'execute') as auth,
          has_function_privilege('anon', p.oid, 'execute') as anon,
          has_function_privilege('service_role', p.oid, 'execute') as svc
        from pg_proc p
        where p.pronamespace = 'goals'::regnamespace
          and p.proname in ('person_for_token', 'oauth_refresh_token', 'oauth_client_by_metadata_url')
        order by p.proname`;
      const shape = fns.map((f) => `${f.name}:${f.secdef ? "definer" : "invoker"}:${(f.config ?? []).join("|")}:${f.auth || f.anon || f.svc ? "open" : "closed"}:${f.src.includes("90 days") ? "90" : "-"}`).join(" ");
      assert(
        "P210",
        shape ===
          'oauth_client_by_metadata_url:definer:search_path="":closed:- oauth_refresh_token:definer:search_path="":closed:90 person_for_token:definer:search_path="":closed:90',
        shape || "no functions",
      );

      await tx`insert into auth.users (id) values (${subject})`;
      const [goal] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${subject}, 'una vez', '2027-12-31') returning id`;
      const [suelta] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, day) values (${subject}, ${goal.id}, 'suelta', current_date) returning id`;
      const [other] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, day) values (${subject}, ${goal.id}, 'otra', current_date) returning id`;
      await enterUserContext(tx, subject);

      const first = await attempt(
        tx,
        (sp) => sp`insert into goals.facts (user_id, one_off_id, day) values (${subject}, ${suelta.id}, current_date)`,
      );
      assert("P211", first.code === undefined, `first fact of a one-off, sqlstate = ${first.code ?? "none"}`);
      const second = await attempt(
        tx,
        (sp) => sp`insert into goals.facts (user_id, one_off_id, day) values (${subject}, ${suelta.id}, current_date - 1)`,
      );
      assert("P212", second.code === "23505", `second fact of the same one-off, sqlstate = ${second.code ?? "none"}`);
      const otherOne = await attempt(
        tx,
        (sp) => sp`insert into goals.facts (user_id, one_off_id, day) values (${subject}, ${other.id}, current_date)`,
      );
      assert("P213", otherOne.code === undefined, `a fact of another one-off, sqlstate = ${otherOne.code ?? "none"}`);

      const lookup = await attempt(
        tx,
        (sp) => sp`select * from goals.oauth_client_by_metadata_url('https://x.example.invalid/meta')`,
      );
      assert("P214", lookup.code === "42501", `authenticated reads a client by URL, sqlstate = ${lookup.code ?? "none"}`);

      const [commitment] = await tx<{ id: string }[]>`
        insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
        values (${subject}, ${goal.id}, 'Tocar', 'daily', 'tap') returning id`;
      for (const [code, back] of [["P215", 2], ["P216", 3]] as const) {
        const written = await attempt(
          tx,
          (sp) => sp`insert into goals.facts (user_id, commitment_id, day) values (${subject}, ${commitment.id}, current_date - ${back}::int)`,
        );
        assert(code, written.code === undefined, `commitment fact ${back - 1} (one_off_id null), sqlstate = ${written.code ?? "none"}`);
      }
      const nulls = await tx<{ n: number }[]>`
        select count(*)::int as n from goals.facts where user_id = ${subject} and one_off_id is null`;
      assert("P217", nulls[0].n === 2, `facts with a null one_off_id = ${nulls[0].n}`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  await sql.end();
}

// 0016 (RP-60): who reads and who writes the address a connection returns to,
// and who may call the lapse rule. Own transaction, forced rollback.
async function checkConnectionHost0016(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");
  const mutant = process.env.CONNECTION_HOST_MUTANT_SQL;
  const callback = "https://claude.ai/api/mcp/auth_callback";

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;
      const [row] = await tx<{ id: string }[]>`
        insert into goals.access_tokens (user_id, kind, name, token_hash, expires_at, redirect_uri)
        values (${subject}, 'oauth', 'Claude', ${sha256()}, now() + interval '1 hour', ${callback}) returning id`;
      if (mutant) {
        console.log(`MUTANT  ${mutant.replace(/\s+/g, " ").slice(0, 140)}`);
        await tx.unsafe(mutant);
      }

      await enterUserContext(tx, subject);
      const own = await attemptRows<{ redirect_uri: string }>(
        tx,
        (sp) => sp`select redirect_uri from goals.access_tokens where id = ${row.id}`,
      );
      assert(
        "P218",
        own.code === undefined && own.rows.length === 1 && own.rows[0].redirect_uri === callback,
        `owner reads the address, sqlstate = ${own.code ?? "none"}, rows = ${own.rows.length}`,
      );
      const rewrite = await attempt(tx, (sp) => sp`update goals.access_tokens set redirect_uri = 'https://x.example.invalid' where id = ${row.id}`);
      assert("P219", rewrite.code === "42501", `update redirect_uri, sqlstate = ${rewrite.code ?? "none"}`);
      const forged = await attempt(
        tx,
        (sp) => sp`insert into goals.access_tokens (user_id, name, token_hash, hint, redirect_uri)
          values (${subject}, 'llave', ${sha256()}, 'abcd', 'https://x.example.invalid')`,
      );
      assert("P220", forged.code === "42501", `insert with redirect_uri, sqlstate = ${forged.code ?? "none"}`);

      await enterUserContext(tx, intruder);
      const foreign = await attemptRows<{ redirect_uri: string }>(
        tx,
        (sp) => sp`select redirect_uri from goals.access_tokens where id = ${row.id}`,
      );
      assert("P221", foreign.code === undefined && foreign.rows.length === 0, `another person reads the address, rows = ${foreign.rows.length}`);

      await tx`reset role`;
      const [fn] = await tx<{ auth: boolean; anon: boolean; svc: boolean; pub: boolean }[]>`
        select has_function_privilege('authenticated', p.oid, 'execute') as auth,
          has_function_privilege('anon', p.oid, 'execute') as anon,
          has_function_privilege('service_role', p.oid, 'execute') as svc,
          exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as pub
        from pg_proc p
        where p.pronamespace = 'goals'::regnamespace and p.proname = 'access_token_lapses_at'`;
      assert(
        "P222",
        !!fn && fn.auth && !fn.anon && !fn.svc && !fn.pub,
        `access_token_lapses_at: authenticated = ${fn?.auth}, anon = ${fn?.anon}, service_role = ${fn?.svc}, public = ${fn?.pub}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  await sql.end();
}

// The driver's constraint name, which a trigger's `RAISE ... CONSTRAINT` fills as a CHECK does.
function pgConstraint(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("constraint_name" in error)) return undefined;
  const { constraint_name: name } = error as { constraint_name: unknown };
  return typeof name === "string" ? name : undefined;
}

async function attemptShape(
  tx: postgres.TransactionSql,
  fn: (sp: postgres.TransactionSql) => Promise<{ count: number }>,
): Promise<{ count: number; code?: string; constraint?: string; detail?: string }> {
  let count = 0;
  let code: string | undefined;
  let constraint: string | undefined;
  let detail: string | undefined;
  await tx.savepoint(async (sp) => {
    count = (await fn(sp)).count;
  }).catch((error: unknown) => {
    code = pgCode(error);
    constraint = pgConstraint(error);
    detail = (error as { detail?: string }).detail;
  });
  return { count, code, constraint, detail };
}

function shape(r: { count: number; code?: string; constraint?: string }): string {
  return `sqlstate = ${r.code ?? "none"}, constraint = ${r.constraint ?? "none"}, rows = ${r.count}`;
}

// RP-78–RP-80, RP-95: `0018`'s `parent_id`, `note` and the tree's guards, driven as `authenticated`
// (a superuser passes a column nobody granted). `GOAL_TREE_MUTANT_SQL` runs privileged at the top of
// each transaction, so a mutant lives and dies inside its rollback.
async function checkGoalTree0018(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");
  const mutant = process.env.GOAL_TREE_MUTANT_SQL;
  if (mutant) console.log(`MUTANT  ${mutant.replace(/\s+/g, " ").slice(0, 140)}`);

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;
      if (mutant) await tx.unsafe(mutant);
      // 0021 rewrote the tree guard whole: a mutant of its body must meet these probes too.
      if (process.env.GOAL_END_MUTANT_SQL) await tx.unsafe(process.env.GOAL_END_MUTANT_SQL);
      const [theirs] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${intruder}, 'ajena', '2027-12-31') returning id`;

      await enterUserContext(tx, subject);
      const general = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`insert into goals.goals (user_id, name, horizon, parent_id, note)
          values (${subject}, 'general', '2027-12-31', null, 'reglas') returning id`,
      );
      const large = await attemptRows<{ id: string }>(
        tx,
        (sp) => sp`insert into goals.goals (user_id, name, horizon, parent_id, note)
          values (${subject}, 'grande', '2027-06-30', ${general.rows[0]?.id ?? null}, null) returning id`,
      );
      assert(
        "P223",
        general.code === undefined && large.code === undefined && general.rows.length === 1 && large.rows.length === 1,
        `insert naming parent_id and note, sqlstate = ${general.code ?? large.code ?? "none"}, rows = ${general.rows.length + large.rows.length}`,
      );
      const G = general.rows[0]?.id ?? randomUUID();
      const L = large.rows[0]?.id ?? randomUUID();

      const [small] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${subject}, 'pequeña', '2027-03-31') returning id`;
      const S = small.id;
      const moveSmall = await attemptShape(
        tx,
        (sp) => sp`update goals.goals set parent_id = ${L}, note = 'bajo la grande' where id = ${S}`,
      );
      assert("P224", moveSmall.code === undefined && moveSmall.count === 1, `update parent_id and note, ${shape(moveSmall)}`);

      const underTheirs = await attemptShape(
        tx,
        (sp) => sp`insert into goals.goals (user_id, name, horizon, parent_id) values (${subject}, 'bajo ajena', '2027-01-31', ${theirs.id})`,
      );
      assert("P225", underTheirs.code === "42501", `insert under another person's goal, ${shape(underTheirs)}`);

      const [lone] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${subject}, 'suelta', '2027-01-31') returning id`;
      const moveUnderTheirs = await attemptShape(
        tx,
        (sp) => sp`update goals.goals set parent_id = ${theirs.id} where id = ${lone.id}`,
      );
      assert("P226", moveUnderTheirs.code === "42501", `update under another person's goal, ${shape(moveUnderTheirs)}`);

      const cycle = await attemptShape(tx, (sp) => sp`update goals.goals set parent_id = ${S} where id = ${G}`);
      assert(
        "P227",
        cycle.code === "23514" && cycle.constraint === "goals_tree_cycle",
        `a goal under its granddaughter, ${shape(cycle)}`,
      );

      const ownParent = await attemptShape(tx, (sp) => sp`update goals.goals set parent_id = ${lone.id} where id = ${lone.id}`);
      assert(
        "P228",
        ownParent.code === "23514" && ownParent.constraint === "goals_not_own_parent",
        `a goal as its own parent, ${shape(ownParent)}`,
      );

      const fourth = await attemptShape(
        tx,
        (sp) => sp`insert into goals.goals (user_id, name, horizon, parent_id) values (${subject}, 'cuarta', '2027-01-31', ${S})`,
      );
      assert(
        "P229",
        fourth.code === "23514" && fourth.constraint === "goals_tree_depth",
        `a goal under a small goal, ${shape(fourth)}`,
      );

      const [branch] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${subject}, 'rama', '2027-03-31') returning id`;
      await tx`insert into goals.goals (user_id, name, horizon, parent_id) values (${subject}, 'hoja', '2027-02-28', ${branch.id})`;
      const branchUnderLarge = await attemptShape(tx, (sp) => sp`update goals.goals set parent_id = ${L} where id = ${branch.id}`);
      assert(
        "P230",
        branchUnderLarge.code === "23514" && branchUnderLarge.constraint === "goals_tree_depth",
        `a two-level branch under a large goal, ${shape(branchUnderLarge)}`,
      );
      const branchUnderGeneral = await attemptShape(tx, (sp) => sp`update goals.goals set parent_id = ${G} where id = ${branch.id}`);
      assert(
        "P231",
        branchUnderGeneral.code === undefined && branchUnderGeneral.count === 1,
        `a two-level branch under a general goal, ${shape(branchUnderGeneral)}`,
      );

      const shorten = await attemptShape(tx, (sp) => sp`update goals.goals set horizon = '2027-03-30' where id = ${L}`);
      assert(
        "P232",
        shorten.code === "23514" && shorten.constraint === "goals_tree_end" && shorten.detail === S,
        `the goal above ends before one of its goals, ${shape(shorten)}, detail = ${shorten.detail ?? "none"}`,
      );

      const dayPast = await attemptShape(
        tx,
        (sp) => sp`insert into goals.goals (user_id, name, horizon, parent_id) values (${subject}, 'un día más', '2027-07-01', ${L})`,
      );
      assert(
        "P233",
        dayPast.code === "23514" && dayPast.constraint === "goals_tree_end",
        `a goal ending a day after the goal above, ${shape(dayPast)}`,
      );
      const sameDay = await attemptShape(
        tx,
        (sp) => sp`insert into goals.goals (user_id, name, horizon, parent_id) values (${subject}, 'mismo día', '2027-06-30', ${L})`,
      );
      assert("P234", sameDay.code === undefined && sameDay.count === 1, `a goal ending the day the goal above ends, ${shape(sameDay)}`);

      await tx`update goals.goals set measure_name = 'horas', measure_unit = 'h' where id = ${G}`;
      const holderRhythm = await attemptShape(tx, (sp) => sp`update goals.goals set rhythm = 10 where id = ${G}`);
      assert(
        "P235",
        holderRhythm.code === "23514" && holderRhythm.constraint === "goals_tree_rhythm",
        `a rhythm on a goal that holds goals, ${shape(holderRhythm)}`,
      );
      const holderMonth = await attemptShape(
        tx,
        (sp) => sp`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${subject}, ${G}, '2026-11-01', 10)`,
      );
      assert(
        "P236",
        holderMonth.code === "23514" && holderMonth.constraint === "month_budgets_holder",
        `a month amount on a goal that holds goals, ${shape(holderMonth)}`,
      );

      // P2 = B: a goal with a rhythm and a month amount still takes goals; the amount then stops moving.
      const [planned] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${subject}, 'con plan', '2027-12-31') returning id`;
      await tx`update goals.goals set measure_name = 'horas', measure_unit = 'h' where id = ${planned.id}`;
      const loneRhythm = await attemptShape(tx, (sp) => sp`update goals.goals set rhythm = 5 where id = ${planned.id}`);
      const loneMonth = await attemptShape(
        tx,
        (sp) => sp`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${subject}, ${planned.id}, '2026-11-01', 5)`,
      );
      assert(
        "P237",
        loneRhythm.count === 1 && loneMonth.count === 1 && !loneRhythm.code && !loneMonth.code,
        `a lone goal takes a rhythm and a month amount, rhythm ${shape(loneRhythm)}, month ${shape(loneMonth)}`,
      );
      const gathered = await attemptShape(
        tx,
        (sp) => sp`insert into goals.goals (user_id, name, horizon, parent_id) values (${subject}, 'reunida', '2027-06-30', ${planned.id})`,
      );
      assert("P238", gathered.code === undefined && gathered.count === 1, `a goal with a plan receives a goal, ${shape(gathered)}`);
      const keptAmount = await attemptShape(
        tx,
        (sp) => sp`update goals.month_budgets set amount = 6 where goal_id = ${planned.id}`,
      );
      assert(
        "P239",
        keptAmount.code === "23514" && keptAmount.constraint === "month_budgets_holder",
        `the stored month amount of a goal that now holds goals, ${shape(keptAmount)}`,
      );

      const [archivedHolder] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${subject}, 'con archivada', '2027-12-31') returning id`;
      await tx`update goals.goals set measure_name = 'horas', measure_unit = 'h' where id = ${archivedHolder.id}`;
      const [archivedChild] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, parent_id) values (${subject}, 'archivada', '2027-06-30', ${archivedHolder.id}) returning id`;
      await tx`update goals.goals set archived_at = now() where id = ${archivedChild.id}`;
      const archivedRhythm = await attemptShape(tx, (sp) => sp`update goals.goals set rhythm = 3 where id = ${archivedHolder.id}`);
      const archivedMonth = await attemptShape(
        tx,
        (sp) => sp`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${subject}, ${archivedHolder.id}, '2026-11-01', 3)`,
      );
      assert(
        "P240",
        archivedRhythm.count === 1 && archivedMonth.count === 1 && !archivedRhythm.code && !archivedMonth.code,
        `a goal holding only archived goals plans, rhythm ${shape(archivedRhythm)}, month ${shape(archivedMonth)}`,
      );

      const notes: [string, string, boolean][] = [
        ["P241", "", false],
        ["P242", "  \n ", false],
        ["P243", "a".repeat(100000), true],
        ["P244", "a".repeat(100001), false],
      ];
      for (const [label, note, admitted] of notes) {
        const r = await attemptShape(tx, (sp) => sp`update goals.goals set note = ${note} where id = ${lone.id}`);
        assert(
          label,
          admitted ? r.code === undefined && r.count === 1 : r.code === "23514" && r.constraint === "goals_note_shape",
          `note of ${note.length} chars (${note.trim() === "" ? "blank" : "text"}), ${shape(r)}`,
        );
      }

      await enterUserContext(tx, intruder);
      const foreign = await attemptShape(tx, (sp) => sp`update goals.goals set note = 'ajena', parent_id = null where id = ${S}`);
      const [after] = await tx<{ n: number }[]>`select count(*)::int as n from goals.goals where id = ${S}`;
      assert(
        "P245",
        foreign.code === undefined && foreign.count === 0 && after.n === 0,
        `another person writes my goal's note and parent, ${shape(foreign)}, visible = ${after.n}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  // Privileged, with no person settled: RLS would hide the intruder's rows from a walk that forgot `user_id`.
  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;
      if (mutant) await tx.unsafe(mutant);
      const [general] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${subject}, 'general', '2027-12-31') returning id`;
      const [large] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, parent_id) values (${subject}, 'grande', '2027-06-30', ${general.id}) returning id`;
      const [mine] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, measure_name, measure_unit)
        values (${subject}, 'mía', '2027-03-31', 'horas', 'h') returning id`;
      // Planted with triggers off: a shape no person can write, which a walk that forgot `user_id` would read.
      await tx`set local session_replication_role = replica`;
      await tx`insert into goals.goals (user_id, name, horizon, parent_id, position) values (${intruder}, 'ajena debajo', '2028-12-31', ${mine.id}, 40)`;
      await tx`set local session_replication_role = origin`;
      const [early] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${intruder}, 'ajena arriba', '2026-01-31') returning id`;

      const depth = await attemptShape(tx, (sp) => sp`update goals.goals set parent_id = ${large.id} where id = ${mine.id}`);
      assert("P246", depth.code === undefined && depth.count === 1, `another person's goal below mine adds no level, ${shape(depth)}`);
      const end = await attemptShape(tx, (sp) => sp`update goals.goals set horizon = '2027-03-30' where id = ${mine.id}`);
      assert("P247", end.code === undefined && end.count === 1, `another person's goal below mine stops no horizon, ${shape(end)}`);
      const rhythm = await attemptShape(tx, (sp) => sp`update goals.goals set rhythm = 4 where id = ${mine.id}`);
      assert("P248", rhythm.code === undefined && rhythm.count === 1, `another person's goal below mine stops no rhythm, ${shape(rhythm)}`);
      const month = await attemptShape(
        tx,
        (sp) => sp`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${subject}, ${mine.id}, '2026-11-01', 4)`,
      );
      assert("P249", month.code === undefined && month.count === 1, `another person's goal below mine stops no month amount, ${shape(month)}`);
      const above = await attemptShape(
        tx,
        (sp) => sp`insert into goals.goals (user_id, name, horizon, parent_id) values (${subject}, 'bajo ajena', '2027-12-31', ${early.id})`,
      );
      assert("P250", above.code === undefined && above.count === 1, `another person's goal above stops no horizon, ${shape(above)}`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  await sql.end();
}

// RNP-21: `0020` admits `source = 'chat'` and nothing else changes. Driven as `authenticated`; own
// transaction, forced rollback.
async function checkModelCallsChat0020(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;
      await enterUserContext(tx, subject);

      const own = await attemptRows<{ id: string; source: string }>(
        tx,
        (sp) => sp`insert into goals.model_calls (user_id, model, source)
          values (${subject}, 'gpt-5.6-luna', 'chat') returning id, source`,
      );
      assert(
        "P251",
        own.code === undefined && own.rows.length === 1 && own.rows[0].source === "chat",
        `own insert with source 'chat', sqlstate = ${own.code ?? "none"}, rows = ${own.rows.length}`,
      );

      const foreign = await attempt(
        tx,
        (sp) => sp`insert into goals.model_calls (user_id, model, source)
          values (${intruder}, 'gpt-5.6-luna', 'chat')`,
      );
      assert("P252", foreign.code === "42501", `insert 'chat' for another person, sqlstate = ${foreign.code ?? "none"}`);

      const unknown = await attempt(
        tx,
        (sp) => sp`insert into goals.model_calls (user_id, model, source) values (${subject}, 'gpt-5.6-luna', 'x')`,
      );
      assert("P253", unknown.code === "23514", `insert source 'x' after 0020, sqlstate = ${unknown.code ?? "none"}`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });
  await sql.end();
}

// RP-99, RP-100: `0021` lets a goal lack its end and a commitment lack its goal, and the tree trigger keeps
// what RP-99 forbids. Driven as `authenticated`; `GOAL_END_MUTANT_SQL` runs privileged inside the rollback.
async function checkNoEndAndLoose0021(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");
  const mutant = process.env.GOAL_END_MUTANT_SQL;
  if (mutant) console.log(`MUTANT  ${mutant.replace(/\s+/g, " ").slice(0, 140)}`);

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;
      if (mutant) await tx.unsafe(mutant);
      const [theirs] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${intruder}, 'ajena', '2027-12-31') returning id`;
      await tx`insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
        values (${intruder}, null, 'hábito ajeno', 'daily', 'tap')`;

      await enterUserContext(tx, subject);
      const endless = await attemptRows<{ id: string; horizon: string | null }>(
        tx,
        (sp) => sp`insert into goals.goals (user_id, name) values (${subject}, 'sin final') returning id, horizon`,
      );
      assert(
        "P254",
        endless.code === undefined && endless.rows.length === 1 && endless.rows[0].horizon === null,
        `insert a goal with no horizon, sqlstate = ${endless.code ?? "none"}, rows = ${endless.rows.length}`,
      );
      const E = endless.rows[0]?.id ?? randomUUID();

      const loose = await attemptRows<{ id: string; goal_id: string | null }>(
        tx,
        (sp) => sp`insert into goals.commitments (user_id, name, cadence_kind, satisfaction)
          values (${subject}, 'suelto', 'daily', 'tap') returning id, goal_id`,
      );
      const retire = loose.rows[0]
        ? await attemptShape(tx, (sp) => sp`update goals.commitments set retired_at = now() where id = ${loose.rows[0].id}`)
        : { count: 0, code: "no row" };
      assert(
        "P255",
        loose.code === undefined && loose.rows.length === 1 && loose.rows[0].goal_id === null && retire.count === 1 && !retire.code,
        `insert a commitment with no goal, sqlstate = ${loose.code ?? "none"}, retire ${shape(retire)}`,
      );

      const [dated] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${subject}, 'con final', '2027-12-31') returning id`;
      const D = dated.id;
      const endlessUnder = await attemptShape(
        tx,
        (sp) => sp`insert into goals.goals (user_id, name, parent_id) values (${subject}, 'sin final abajo', ${D})`,
      );
      assert(
        "P256",
        endlessUnder.code === "23514" && endlessUnder.constraint === "goals_tree_end" && endlessUnder.detail === D,
        `insert with no horizon under a goal that has one, ${shape(endlessUnder)}, detail = ${endlessUnder.detail ?? "none"}`,
      );

      const [inside] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, parent_id) values (${subject}, 'dentro', '2027-06-30', ${D}) returning id`;
      const clear = await attemptShape(tx, (sp) => sp`update goals.goals set horizon = null where id = ${inside.id}`);
      assert(
        "P257",
        clear.code === "23514" && clear.constraint === "goals_tree_end" && clear.detail === D,
        `clear the horizon of a goal inside one that has one, ${shape(clear)}, detail = ${clear.detail ?? "none"}`,
      );

      const datedUnder = await attemptShape(
        tx,
        (sp) => sp`insert into goals.goals (user_id, name, horizon, parent_id) values (${subject}, 'con final abajo', '2030-01-31', ${E})`,
      );
      assert("P258", datedUnder.code === undefined && datedUnder.count === 1, `a goal with a horizon under one with none, ${shape(datedUnder)}`);

      const [holder] = await tx<{ id: string }[]>`insert into goals.goals (user_id, name) values (${subject}, 'abierta') returning id`;
      const [open] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, parent_id) values (${subject}, 'abierta dentro', ${holder.id}) returning id`;
      await tx`update goals.goals set archived_at = now() where id = ${open.id}`;
      const give = await attemptShape(tx, (sp) => sp`update goals.goals set horizon = '2027-01-01' where id = ${holder.id}`);
      assert(
        "P259",
        give.code === "23514" && give.constraint === "goals_tree_no_end" && give.detail === open.id,
        `give an end to a goal holding one with none, archived or not, ${shape(give)}, detail = ${give.detail ?? "none"}`,
      );

      const [bare] = await tx<{ id: string }[]>`insert into goals.goals (user_id, name) values (${subject}, 'sola') returning id`;
      const giveBare = await attemptShape(tx, (sp) => sp`update goals.goals set horizon = '2027-01-01' where id = ${bare.id}`);
      assert("P260", giveBare.code === undefined && giveBare.count === 1, `give an end to a goal holding none, ${shape(giveBare)}`);

      const [priv] = await tx<{ goal: boolean; note: boolean; noteInsert: boolean }[]>`
        select has_column_privilege('authenticated', 'goals.commitments', 'goal_id', 'UPDATE') as goal,
               has_column_privilege('authenticated', 'goals.commitments', 'note', 'UPDATE') as note,
               has_column_privilege('authenticated', 'goals.commitments', 'note', 'INSERT') as "noteInsert"`;
      assert(
        "P261",
        priv.goal === false && priv.note === true && priv.noteInsert === true,
        `commitments grants: goal_id update ${priv.goal}, note update ${priv.note}, note insert ${priv.noteInsert}`,
      );

      const [mine] = await tx<{ id: string }[]>`insert into goals.goals (user_id, name, horizon) values (${subject}, 'mía', '2027-01-31') returning id`;
      const own = await attemptShape(
        tx,
        (sp) => sp`insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
          values (${subject}, ${mine.id}, 'con meta', 'daily', 'tap')`,
      );
      assert("P262", own.code === undefined && own.count === 1, `a commitment under my own goal, ${shape(own)}`);
      const alien = await attemptShape(
        tx,
        (sp) => sp`insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
          values (${subject}, ${theirs.id}, 'con meta ajena', 'daily', 'tap')`,
      );
      assert("P263", alien.code === "42501", `a commitment under another person's goal, ${shape(alien)}`);

      const notes: [string, string, boolean][] = [
        ["P264", "", false],
        ["P265", "  \n ", false],
        ["P266", "a".repeat(2000), true],
        ["P267", "a".repeat(2001), false],
      ];
      for (const [label, note, admitted] of notes) {
        const r = await attemptShape(
          tx,
          (sp) => sp`insert into goals.commitments (user_id, name, cadence_kind, satisfaction, note)
            values (${subject}, 'con nota', 'daily', 'tap', ${note})`,
        );
        assert(
          label,
          admitted ? r.code === undefined && r.count === 1 : r.code === "23514" && r.constraint === "commitments_note_shape",
          `commitment note of ${note.length} chars (${note.trim() === "" ? "blank" : "text"}), ${shape(r)}`,
        );
      }

      const seen = await tx<{ name: string }[]>`select name from goals.commitments where name = 'hábito ajeno'`;
      assert("P268", seen.length === 0, `another person's loose commitment seen as mine, rows = ${seen.length}`);

      // A person writes only under their own id, with a goal or without one (RP-100).
      const foreignLoose = await attemptShape(
        tx,
        (sp) => sp`insert into goals.commitments (user_id, name, cadence_kind, satisfaction)
          values (${intruder}, 'a nombre de otro', 'daily', 'tap')`,
      );
      assert("P269", foreignLoose.code === "42501", `a loose commitment written under another person's id, ${shape(foreignLoose)}`);
      const foreignOnMine = await attemptShape(
        tx,
        (sp) => sp`insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
          values (${intruder}, ${mine.id}, 'a nombre de otro, en mi meta', 'daily', 'tap')`,
      );
      assert("P270", foreignOnMine.code === "42501", `a commitment on my goal written under another person's id, ${shape(foreignOnMine)}`);

      // The goal above may end the very day a goal inside it ends; only a later end is refused.
      const [top] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${subject}, 'arriba', '2028-12-31') returning id`;
      await tx`insert into goals.goals (user_id, name, horizon, parent_id) values (${subject}, 'abajo', '2028-06-30', ${top.id})`;
      const meet = await attemptShape(tx, (sp) => sp`update goals.goals set horizon = '2028-06-30' where id = ${top.id}`);
      assert("P271", meet.code === undefined && meet.count === 1, `the goal above moved to the day the goal inside ends, ${shape(meet)}`);
      const pass = await attemptShape(tx, (sp) => sp`update goals.goals set horizon = '2028-06-29' where id = ${top.id}`);
      assert("P272", pass.code === "23514" && pass.constraint === "goals_tree_end", `the goal above moved to the day before the goal inside ends, ${shape(pass)}`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });
  await sql.end();
}

// RP-104: `0022` opens `name` on a person's own commitment and no other column. Driven as `authenticated`;
// `COMMITMENT_NAME_MUTANT_SQL` runs privileged inside the rollback.
async function checkCommitmentName0022(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");
  const mutant = process.env.COMMITMENT_NAME_MUTANT_SQL;
  if (mutant) console.log(`MUTANT  ${mutant.replace(/\s+/g, " ").slice(0, 140)}`);

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;
      if (mutant) await tx.unsafe(mutant);
      await tx`insert into goals.commitments (user_id, name, cadence_kind, satisfaction)
        values (${intruder}, 'hábito ajeno', 'daily', 'tap')`;

      // No WHERE: one that reads `id` hides the other row behind the SELECT policy, `using (true)` or not.
      await enterUserContext(tx, subject);
      const foreign = await attemptShape(tx, (sp) => sp`update goals.commitments set name = 'tomado'`);
      assert("P273", foreign.code === undefined && foreign.count === 0, `rename with only another person's row, ${shape(foreign)}`);

      const [mine] = await tx<{ id: string }[]>`
        insert into goals.commitments (user_id, name, cadence_kind, satisfaction)
        values (${subject}, 'leer', 'daily', 'tap') returning id`;
      const own = await attemptShape(tx, (sp) => sp`update goals.commitments set name = 'leer en voz alta' where id = ${mine.id}`);
      const [after] = await tx<{ name: string }[]>`select name from goals.commitments where id = ${mine.id}`;
      assert(
        "P274",
        own.code === undefined && own.count === 1 && after?.name === "leer en voz alta",
        `rename my own commitment, ${shape(own)}, reads back ${after?.name ?? "nothing"}`,
      );

      // 0025 opens the cadence of a commitment no fact names (RP-127); the guard with facts is P18c.
      const cadence = await attemptShape(
        tx,
        (sp) => sp`update goals.commitments set cadence_kind = 'weekdays', cadence_weekdays = '{1,3}' where id = ${mine.id}`,
      );
      assert("P275", cadence.code === undefined && cadence.count === 1, `update my fact-less commitment's cadence, ${shape(cadence)}`);

      const closed: [string, string, (sp: postgres.TransactionSql) => Promise<{ count: number }>][] = [
        ["P276", "target_quantity", (sp) => sp`update goals.commitments set target_quantity = 3 where id = ${mine.id}`],
        ["P277", "goal_id", (sp) => sp`update goals.commitments set goal_id = null where id = ${mine.id}`],
      ];
      for (const [label, column, fn] of closed) {
        const r = await attemptShape(tx, fn);
        assert(label, r.code === "42501", `update commitment.${column} after 0022, ${shape(r)}`);
      }

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });
  await sql.end();
}

// Every `goals.commitments` column `authenticated` may not update, each proved closed on the person's own row:
// a grant is the only guard, since the update policy passes the owner. `user_id` is set to its own value so
// only the grant can refuse it. Reads `COMMITMENT_NAME_MUTANT_SQL`, run privileged inside the rollback.
async function checkCommitmentClosedColumns(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const forcedRollback = Symbol("forced rollback");
  const mutant = process.env.COMMITMENT_NAME_MUTANT_SQL;
  if (mutant) console.log(`MUTANT  ${mutant.replace(/\s+/g, " ").slice(0, 140)}`);

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject})`;
      if (mutant) await tx.unsafe(mutant);
      const [first] = await tx<{ id: string }[]>`select id from goals.evidence_sources where key = 'reading_lookups'`;
      const [second] = await tx<{ id: string }[]>`
        insert into goals.evidence_sources (key, label_key, unit) values ('check_policies_second', 'sources.second', 'searches')
        returning id`;
      const [tap] = await tx<{ id: string }[]>`
        insert into goals.commitments (user_id, name, cadence_kind, satisfaction)
        values (${subject}, 'tocar', 'daily', 'tap') returning id`;
      const [counted] = await tx<{ id: string }[]>`
        insert into goals.commitments (user_id, name, cadence_kind, cadence_n, satisfaction, source_id, threshold)
        values (${subject}, 'buscar', 'times_per_week', 3, 'evidence', ${first.id}, 2) returning id`;
      const [weekdays] = await tx<{ id: string }[]>`
        insert into goals.commitments (user_id, name, cadence_kind, cadence_weekdays, satisfaction)
        values (${subject}, 'correr', 'weekdays', '{1,3}', 'tap') returning id`;

      await enterUserContext(tx, subject);
      const row = async (id: string) =>
        (await tx<{ row: string }[]>`select to_jsonb(c)::text as row from goals.commitments c where id = ${id}`)[0]?.row;

      // Each value would pass every check on its row, so a grant alone decides the outcome.
      const closed: [string, string, string, (sp: postgres.TransactionSql) => Promise<{ count: number }>][] = [
        ["P278", "created_at", tap.id, (sp) => sp`update goals.commitments set created_at = '2020-01-01T00:00:00Z' where id = ${tap.id}`],
        ["P279", "satisfaction", tap.id, (sp) => sp`update goals.commitments set satisfaction = 'tap' where id = ${tap.id}`],
        ["P282", "threshold", counted.id, (sp) => sp`update goals.commitments set threshold = 5 where id = ${counted.id}`],
        ["P283", "source_id", counted.id, (sp) => sp`update goals.commitments set source_id = ${second.id} where id = ${counted.id}`],
        ["P284", "position", tap.id, (sp) => sp`update goals.commitments set position = 99 where id = ${tap.id}`],
        ["P285", "user_id", tap.id, (sp) => sp`update goals.commitments set user_id = ${subject} where id = ${tap.id}`],
        ["P286", "id", tap.id, (sp) => sp`update goals.commitments set id = ${randomUUID()} where id = ${tap.id}`],
      ];
      for (const [label, column, id, fn] of closed) {
        const before = await row(id);
        const r = await attemptShape(tx, fn);
        const after = await row(id);
        assert(
          label,
          r.code === "42501" && before !== undefined && after === before,
          `update my own commitment.${column}, ${shape(r)}, row ${after === before ? "unchanged" : "changed"}`,
        );
      }

      // `cadence_n` and `cadence_weekdays` open in 0025 on a row no fact names (RP-127).
      const open: [string, string, (sp: postgres.TransactionSql) => Promise<{ count: number }>][] = [
        ["P280", "cadence_n", (sp) => sp`update goals.commitments set cadence_n = 4 where id = ${counted.id}`],
        ["P281", "cadence_weekdays", (sp) => sp`update goals.commitments set cadence_weekdays = '{2,4}' where id = ${weekdays.id}`],
        ["P287", "name", (sp) => sp`update goals.commitments set name = 'tocar dos veces' where id = ${tap.id}`],
        ["P288", "note", (sp) => sp`update goals.commitments set note = 'antes de dormir' where id = ${tap.id}`],
        ["P289", "retired_at", (sp) => sp`update goals.commitments set retired_at = now() where id = ${tap.id}`],
      ];
      for (const [label, column, fn] of open) {
        const r = await attemptShape(tx, fn);
        assert(label, r.code === undefined && r.count === 1, `update my own commitment.${column}, ${shape(r)}`);
      }

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });
  await sql.end();
}

// RP-127 (0025): what no fact depends on is deleted and edited; what a fact depends on is refused in the database.
// `facts.commitment_id` and `facts.goal_id` cascade, so the delete policies are all that keeps a fact. Driven bare under
// a settled session. `DELETE_EDIT_MUTANT_SQL` runs privileged at the top of the rollback, so a mutant dies with it.
async function checkDeleteAndEdit0025(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");
  const mutant = process.env.DELETE_EDIT_MUTANT_SQL;
  if (mutant) console.log(`MUTANT  ${mutant.replace(/\s+/g, " ").slice(0, 140)}`);

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;
      if (mutant) await tx.unsafe(mutant);

      const goal = async (userId: string, name: string, parentId: string | null = null) =>
        (await tx<{ id: string }[]>`
          insert into goals.goals (user_id, name, horizon, parent_id)
          values (${userId}, ${name}, '2026-12-31', ${parentId}) returning id`)[0].id;
      const commitment = async (goalId: string | null, name: string) =>
        (await tx<{ id: string }[]>`
          insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
          values (${subject}, ${goalId}, ${name}, 'daily', 'tap') returning id`)[0].id;
      const factOn = async (commitmentId: string, goalId: string | null = null) =>
        (await tx<{ id: string }[]>`
          insert into goals.facts (user_id, commitment_id, goal_id, day)
          values (${subject}, ${commitmentId}, ${goalId}, '2026-09-22') returning id`)[0].id;
      const factOnTask = async (oneOffId: string) =>
        (await tx<{ id: string }[]>`
          insert into goals.facts (user_id, one_off_id, day) values (${subject}, ${oneOffId}, '2026-09-22') returning id`)[0].id;
      const task = async (goalId: string, name: string, parentId: string | null = null) =>
        (await tx<{ id: string }[]>`
          insert into goals.one_offs (user_id, goal_id, name, parent_id, in_plan)
          values (${subject}, ${goalId}, ${name}, ${parentId}, true) returning id`)[0].id;

      // Planted privileged: a sub-task under another goal than its parent's is a shape no insert policy lets a person
      // write, and the only one where the sub-task arm alone refuses (docs/TRAPS.md, «A probe of a SECURITY INVOKER trigger»).
      const empty = await goal(subject, "vacía");
      const [emptyPhase] = await tx<{ id: string }[]>`
        insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
        values (${subject}, ${empty}, 'fase', '2026-01-01', '2026-06-30') returning id`;
      await commitment(empty, "sin hechos");
      await task(empty, "tarea");
      await tx`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${subject}, ${empty}, '2026-10-01', 30)`;

      const viaCommitment = await goal(subject, "con hábito con hecho");
      const viaCommitmentFact = await factOn(await commitment(viaCommitment, "con hecho"));
      const viaTask = await goal(subject, "con tarea hecha");
      const viaTaskFact = await factOnTask(await task(viaTask, "hecha"));
      const viaSubTask = await goal(subject, "con subtarea hecha");
      const elsewhere = await goal(subject, "otra");
      const viaSubTaskFact = await factOnTask(await task(elsewhere, "hija", await task(viaSubTask, "madre")));
      const viaGoalId = await goal(subject, "nombrada por un hecho");
      const viaGoalIdFact = await factOn(await commitment(null, "suelto que la nombra"), viaGoalId);
      const holder = await goal(subject, "con metas dentro");
      await goal(subject, "dentro", holder);

      const habits = await goal(subject, "hábitos");
      const withFact = await commitment(habits, "explica hechos");
      const withFactFact = await factOn(withFact);
      const factless = await commitment(habits, "editable");
      const retired = await commitment(habits, "retirado");
      await tx`update goals.commitments set retired_at = now() where id = ${retired}`;
      const looseFactless = await commitment(null, "suelto sin hechos");
      const looseWithFact = await commitment(null, "suelto con hechos");
      await factOn(looseWithFact);

      const theirGoal = await goal(intruder, "ajena");
      const [theirPhase] = await tx<{ id: string }[]>`
        insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
        values (${intruder}, ${theirGoal}, 'ajena', '2026-01-01', '2026-06-30') returning id`;
      const [ownPhases] = await tx<{ n: number }[]>`select count(*)::int as n from goals.phases where user_id = ${subject}`;

      await enterUserContext(tx, subject);
      const visible = async (table: "facts" | "goals", id: string) =>
        (await tx<{ id: string }[]>`select id from ${tx("goals")}.${tx(table)} where id = ${id}`).length === 1;
      const cadenceOf = async (id: string) =>
        (await tx<{ c: string }[]>`
          select concat_ws('|', cadence_kind, cadence_n, cadence_weekdays::text) as c from goals.commitments where id = ${id}`)[0]?.c;
      // A 42501 is the guard's only while the grant is open: before 0025 the grant alone answers it.
      const [{ granted }] = await tx<{ granted: boolean }[]>`
        select bool_and(has_column_privilege('authenticated', 'goals.commitments', c, 'UPDATE')) as granted
        from unnest(array['cadence_kind', 'cadence_n', 'cadence_weekdays']) c`;
      const toCounted = (id: string) => (sp: postgres.TransactionSql) =>
        sp`update goals.commitments set cadence_kind = 'times_per_week', cadence_n = 3 where id = ${id}`;

      // The catalogue, not a probe: a column granted by mistake is a column anyone can write.
      // Phases open `aim`, `starts_on`, `ends_on`; commitments open the retire stamp, the name, the note and the cadence.
      const updatable = async (table: "phases" | "commitments") =>
        (
          await tx<{ column_name: string }[]>`
            select a.attname as column_name
            from pg_attribute a
            where a.attrelid = ${`goals.${table}`}::regclass and a.attnum > 0 and not a.attisdropped
              and has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE')
            order by a.attname`
        ).map((row) => row.column_name);
      const phaseColumns = (await updatable("phases")).join(",");
      assert("P19e", phaseColumns === "aim,ends_on,starts_on", `columns of goals.phases that authenticated may update: ${phaseColumns}`);
      const commitmentColumns = (await updatable("commitments")).join(",");
      assert(
        "P18i",
        commitmentColumns === "cadence_kind,cadence_n,cadence_weekdays,name,note,retired_at",
        `columns of goals.commitments that authenticated may update: ${commitmentColumns}`,
      );

      // -- phases --
      // No WHERE and no RETURNING: either one reads rows through the SELECT policy and hides a `using (true)`.
      const span = await attemptShape(
        tx,
        (sp) => sp`update goals.phases set aim = 'otra meta', starts_on = '2026-02-01', ends_on = '2026-07-31'`,
      );
      const [mine] = await tx<{ aim: string; span: string }[]>`
        select aim, starts_on::text || '..' || ends_on::text as span from goals.phases where id = ${emptyPhase.id}`;
      assert(
        "P19c",
        span.code === undefined && span.count === ownPhases.n && mine?.aim === "otra meta" && mine.span === "2026-02-01..2026-07-31",
        `update my phases' aim and span with no WHERE, ${shape(span)} of ${ownPhases.n} mine, reads ${mine?.aim} ${mine?.span}`,
      );

      const theirPhaseDelete = await attemptShape(tx, (sp) => sp`delete from goals.phases where id = ${theirPhase.id}`);
      assert(
        "P19b",
        theirPhaseDelete.code === undefined && theirPhaseDelete.count === 0,
        `delete another person's phase, ${shape(theirPhaseDelete)}`,
      );

      // -- commitments --
      const withFactDelete = await attemptShape(tx, (sp) => sp`delete from goals.commitments where id = ${withFact}`);
      const factKept = await visible("facts", withFactFact);
      assert(
        "P18b",
        withFactDelete.code === undefined && withFactDelete.count === 0 && factKept,
        `delete my commitment that explains a fact, ${shape(withFactDelete)}, fact ${factKept ? "kept" : "gone"}`,
      );

      const refused: [string, string, string][] = [
        ["P18c", "a commitment a fact names", withFact],
        ["P18f", "a retired commitment no fact names", retired],
        ["P18h", "a loose habit a fact names", looseWithFact],
      ];
      for (const [label, what, id] of refused) {
        const before = await cadenceOf(id);
        const r = await attemptShape(tx, toCounted(id));
        const after = await cadenceOf(id);
        assert(
          label,
          granted && r.code === "42501" && before !== undefined && after === before,
          `cadence of ${what}, grant ${granted ? "open" : "closed"}, ${shape(r)}, cadence ${after === before ? "unchanged" : `now ${after}`}`,
        );
      }

      const passes: [string, string, string][] = [
        ["P18d", "a commitment no fact names", factless],
        ["P18g", "a loose habit no fact names", looseFactless],
      ];
      for (const [label, what, id] of passes) {
        const r = await attemptShape(tx, toCounted(id));
        const after = await cadenceOf(id);
        assert(label, r.code === undefined && r.count === 1 && after === "times_per_week|3", `cadence of ${what}, ${shape(r)}, reads ${after ?? "nothing"}`);
      }

      // Outside the cadence a commitment with facts still moves: retiring is how it ends.
      const stillOpen: [string, (sp: postgres.TransactionSql) => Promise<{ count: number }>][] = [
        ["name", (sp) => sp`update goals.commitments set name = 'explica hechos, renombrado' where id = ${withFact}`],
        ["note", (sp) => sp`update goals.commitments set note = 'una nota' where id = ${withFact}`],
        ["retired_at", (sp) => sp`update goals.commitments set retired_at = now() where id = ${withFact}`],
      ];
      for (const [column, fn] of stillOpen) {
        const r = await attemptShape(tx, fn);
        assert(`P18e.${column}`, r.code === undefined && r.count === 1, `update ${column} of my commitment with a fact, ${shape(r)}`);
      }

      // -- goals --
      const refusedGoals: [string, string, string, string][] = [
        ["P37c", "a commitment of it holds a fact", viaCommitment, viaCommitmentFact],
        ["P37f", "a task of it holds a fact", viaTask, viaTaskFact],
        ["P37b", "a sub-task of its task holds a fact", viaSubTask, viaSubTaskFact],
        ["P37g", "a loose habit's fact names it by goal_id", viaGoalId, viaGoalIdFact],
      ];
      for (const [label, what, id, factId] of refusedGoals) {
        const r = await attemptShape(tx, (sp) => sp`delete from goals.goals where id = ${id}`);
        const kept = (await visible("goals", id)) && (await visible("facts", factId));
        assert(label, r.code === undefined && r.count === 0 && kept, `delete my goal where ${what}, ${shape(r)}, goal and fact ${kept ? "kept" : "gone"}`);
      }

      const holderDelete = await attemptShape(tx, (sp) => sp`delete from goals.goals where id = ${holder}`);
      assert(
        "P37d",
        holderDelete.code === "23503" && holderDelete.constraint === "goals_parent_id_goals_id_fk" && (await visible("goals", holder)),
        `delete my goal that holds a goal, ${shape(holderDelete)}`,
      );

      const theirGoalDelete = await attemptShape(tx, (sp) => sp`delete from goals.goals where id = ${theirGoal}`);
      assert("P37e", theirGoalDelete.code === undefined && theirGoalDelete.count === 0, `delete another person's goal, ${shape(theirGoalDelete)}`);

      const emptyDelete = await attemptRows<{ id: string }>(tx, (sp) => sp`delete from goals.goals where id = ${empty} returning id`);
      const [left] = await tx<{ n: string }[]>`
        select concat_ws(',',
          (select count(*) from goals.phases where goal_id = ${empty}),
          (select count(*) from goals.commitments where goal_id = ${empty}),
          (select count(*) from goals.one_offs where goal_id = ${empty}),
          (select count(*) from goals.month_budgets where goal_id = ${empty})) as n`;
      assert(
        "P37",
        emptyDelete.code === undefined && emptyDelete.rows.length === 1 && left.n === "0,0,0,0",
        `delete my fact-free goal, sqlstate = ${emptyDelete.code ?? "none"}, rows = ${emptyDelete.rows.length}, phases,commitments,one-offs,budgets left = ${left.n}`,
      );

      await enterUserContext(tx, intruder);
      const [theirs] = await tx<{ phase: string | null; goals: number }[]>`
        select (select aim from goals.phases where id = ${theirPhase.id}) as phase,
               (select count(*)::int from goals.goals where id = ${theirGoal}) as goals`;
      assert(
        "P19d",
        theirs.phase === "ajena" && theirs.goals === 1,
        `another person's phase and goal after my update and deletes, aim = ${theirs.phase ?? "gone"}, goals = ${theirs.goals}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  // A delete that names no row and asks for none back reads nothing through the SELECT policy, so the delete policy
  // alone says whose rows it may take. Another person's goal, phase and commitment stay (RP-127).
  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;
      if (mutant) await tx.unsafe(mutant);
      const mine = (
        await tx<{ id: string }[]>`
          insert into goals.goals (user_id, name, horizon) values (${subject}, 'mía', '2026-12-31') returning id`
      )[0].id;
      const theirs = (
        await tx<{ id: string }[]>`
          insert into goals.goals (user_id, name, horizon) values (${intruder}, 'ajena', '2026-12-31') returning id`
      )[0].id;
      for (const [user, goalId] of [
        [subject, mine],
        [intruder, theirs],
      ] as const) {
        await tx`insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on) values (${user}, ${goalId}, 'f', '2026-01-01', '2026-02-01')`;
        await tx`insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction) values (${user}, ${goalId}, 'c', 'daily', 'tap')`;
      }
      await enterUserContext(tx, subject);
      const took: Record<string, string> = {};
      // Children first: the goal's own delete would cascade over them and hide which statement took what.
      for (const table of ["phases", "commitments", "goals"] as const) {
        const r = await attemptShape(tx, (sp) => sp`delete from ${sp("goals")}.${sp(table)}`);
        took[table] = shape(r);
      }
      await enterUserContext(tx, intruder);
      const [left] = await tx<{ goals: number; phases: number; commitments: number }[]>`
        select (select count(*)::int from goals.goals where id = ${theirs}) as goals,
               (select count(*)::int from goals.phases where goal_id = ${theirs}) as phases,
               (select count(*)::int from goals.commitments where goal_id = ${theirs}) as commitments`;
      assert(
        "P37i",
        left.goals === 1 && left.phases === 1 && left.commitments === 1,
        `another person's goal, phases, commitments after my bare deletes: ${left.goals},${left.phases},${left.commitments}; mine: ${JSON.stringify(took)}`,
      );
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  // `anon` deletes nothing: refused before RLS, row by row.
  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject})`;
      const [g] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${subject}, 'de nadie', '2026-12-31') returning id`;
      await tx`insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on) values (${subject}, ${g.id}, 'f', '2026-01-01', '2026-02-01')`;
      await tx`insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction) values (${subject}, ${g.id}, 'c', 'daily', 'tap')`;
      await tx`select set_config('role', 'anon', true)`;
      for (const table of ["phases", "commitments", "goals"] as const) {
        const r = await attemptShape(tx, (sp) => sp`delete from ${sp("goals")}.${sp(table)} where user_id = ${subject}`);
        assert(`P37h.${table}`, r.code === "42501" && r.count === 0, `anon delete from ${table}, ${shape(r)}`);
      }
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });
  await sql.end();
}

// RP-131 (0025): the list of who may ask for a link is read by the server alone, never by an API role.
// `ALLOWED_EMAILS_MUTANT_SQL` runs privileged at the top of the rollback.
async function checkAllowedEmails0025(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const forcedRollback = Symbol("forced rollback");
  const mutant = process.env.ALLOWED_EMAILS_MUTANT_SQL;
  if (mutant) console.log(`MUTANT  ${mutant.replace(/\s+/g, " ").slice(0, 140)}`);

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject})`;
      if (mutant) await tx.unsafe(mutant);

      // -- the shape, privileged, so only the CHECK can refuse --
      const shapes: [string, string, string | undefined][] = [
        ["P299", "A@B.co ", "23514"],
        ["P300", "@b.co", "23514"],
        ["P301", "nadie", "23514"],
        ["P302", "persona@ejemplo.co", undefined],
      ];
      for (const [label, email, expected] of shapes) {
        const r = await attemptShape(tx, (sp) => sp`insert into goals.allowed_emails (email) values (${email})`);
        assert(label, r.code === expected && (expected !== undefined || r.count === 1), `insert ${JSON.stringify(email)}, ${shape(r)}`);
      }

      // -- the seed: whoever owned a row before the list was made is on it --
      const seed = await attemptRows<{ owners: number; missing: number; sample: string | null }>(
        tx,
        (sp) => sp`
          with cutoff as (select coalesce(min(added_at), now()) as at from goals.allowed_emails),
          owners as (
            select user_id from goals.goals, cutoff where created_at < cutoff.at
            union select user_id from goals.commitments, cutoff where created_at < cutoff.at
            union select user_id from goals.one_offs, cutoff where created_at < cutoff.at
          )
          select count(*)::int as owners,
                 count(*) filter (where a.email is null)::int as missing,
                 min(u.email) filter (where a.email is null) as sample
          from owners o
          join auth.users u on u.id = o.user_id and u.email is not null
          left join goals.allowed_emails a on a.email = lower(btrim(u.email))`,
      );
      const s = seed.rows[0];
      assert(
        "P298",
        seed.code === undefined && s !== undefined && s.missing === 0,
        `owners before the list = ${s?.owners ?? "?"}, missing from it = ${s?.missing ?? "?"}${s?.sample ? ` (${s.sample})` : ""}, sqlstate = ${seed.code ?? "none"}`,
      );

      // -- the catalogue: in a schema we made, a missing grant and a revoked one refuse alike (docs/TRAPS.md :1937) --
      const catalogue = await attemptRows<{ grants: string | null; rls: boolean; policies: number }>(
        tx,
        (sp) => sp`
          select
            (select string_agg(grantee || ':' || privilege_type, ',') from information_schema.role_table_grants
              where table_schema = 'goals' and table_name = 'allowed_emails'
                and grantee in ('anon', 'authenticated', 'service_role')) as grants,
            (select relrowsecurity from pg_class where oid = 'goals.allowed_emails'::regclass) as rls,
            (select count(*)::int from pg_policies where schemaname = 'goals' and tablename = 'allowed_emails') as policies`,
      );
      const c = catalogue.rows[0];
      assert(
        "P296",
        catalogue.code === undefined && c !== undefined && c.grants === null,
        `grants to API roles on allowed_emails = ${c?.grants ?? "none"}, sqlstate = ${catalogue.code ?? "none"}`,
      );
      assert(
        "P297",
        catalogue.code === undefined && c?.rls === true && c.policies === 0,
        `allowed_emails RLS = ${c?.rls ?? "?"}, policies = ${c?.policies ?? "?"}`,
      );

      // -- driven: `authenticated` holds USAGE on `goals`, so only the table's own grants answer it --
      await enterUserContext(tx, subject);
      const acts: [string, string, (sp: postgres.TransactionSql) => Promise<{ count: number }>][] = [
        ["P290", "select", (sp) => sp`select email from goals.allowed_emails`],
        ["P291", "insert", (sp) => sp`insert into goals.allowed_emails (email) values ('colado@ejemplo.co')`],
        ["P292", "update", (sp) => sp`update goals.allowed_emails set email = 'colado@ejemplo.co'`],
        ["P293", "delete", (sp) => sp`delete from goals.allowed_emails`],
      ];
      for (const [label, act, fn] of acts) {
        const r = await attemptShape(tx, fn);
        assert(label, r.code === "42501", `authenticated ${act} allowed_emails, ${shape(r)}`);
      }

      // `anon` and `service_role` hold no USAGE on `goals`: P296 is what catches a grant to them.
      for (const [label, role] of [["P294", "anon"], ["P295", "service_role"]] as const) {
        for (const act of ["select", "insert"] as const) {
          const r = await attemptShape(tx, async (sp) => {
            await sp`select set_config('role', ${role}, true)`;
            return act === "select"
              ? sp`select email from goals.allowed_emails`
              : sp`insert into goals.allowed_emails (email) values ('colado@ejemplo.co')`;
          });
          assert(`${label}.${act}`, r.code === "42501", `${role} ${act} allowed_emails, ${shape(r)}`);
        }
      }

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });
  await sql.end();
}

// RP-138: `0026`'s daily claim counter for sign-in codes. `SIGN_IN_CLAIMS_MUTANT_SQL` runs privileged at the
// top of the transaction (a mutant, or the whole migration to prove the suite can go green); it rolls back with it.
async function checkSignInClaims0026(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const subject = randomUUID();
  const forcedRollback = Symbol("forced rollback");
  const mutant = process.env.SIGN_IN_CLAIMS_MUTANT_SQL;
  if (mutant) console.log(`MUTANT  ${mutant.replace(/\s+/g, " ").slice(0, 140)}`);

  const today = "2026-10-17";
  const yesterday = "2026-10-16";
  const keyA = randomUUID().replace(/-/g, "");
  const keyB = randomUUID().replace(/-/g, "");
  const keyC = randomUUID().replace(/-/g, "");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject})`;
      if (mutant) await tx.unsafe(mutant);

      const claim = async (key: string, day: string, cap: number): Promise<string> => {
        const r = await attemptRows<{ ok: boolean | null }>(
          tx,
          (sp) => sp`select goals.sign_in_claim(decode(${key}, 'hex'), ${day}::date, ${cap}::integer) as ok`,
        );
        return r.code ? `err ${r.code}` : String(r.rows[0]?.ok);
      };
      const release = async (keys: string[], day: string): Promise<string | undefined> => {
        const r = await attemptRows(
          tx,
          (sp) => sp`select goals.sign_in_release(coalesce((select array_agg(decode(k, 'hex')) from unnest(${tx.array(keys)}::text[]) k), '{}'::bytea[]), ${day}::date)`,
        );
        return r.code;
      };
      const countOf = async (key: string, day: string): Promise<number | null> => {
        const r = await attemptRows<{ count: number }>(
          tx,
          (sp) => sp`select count from goals.sign_in_claims where client_key = decode(${key}, 'hex') and day = ${day}::date`,
        );
        return r.code ? -1 : (r.rows[0]?.count ?? null);
      };
      const snapshot = async (): Promise<string> => {
        const r = await attemptRows<{ s: string | null }>(
          tx,
          (sp) => sp`select string_agg(encode(client_key, 'hex') || '/' || day || '/' || count, ',' order by client_key, day) as s from goals.sign_in_claims`,
        );
        return r.code ? `err ${r.code}` : (r.rows[0]?.s ?? "");
      };

      // -- the cap holds, and a refusal leaves the count where it was --
      const sent = [await claim(keyA, today, 2), await claim(keyA, today, 2), await claim(keyA, today, 2)];
      assert("S01", sent.join() === "true,true,false", `claim x3 at cap 2 = ${sent.join()}`);
      assert("S02", (await countOf(keyA, today)) === 2, `count after the refusal = ${await countOf(keyA, today)}`);
      const again = await claim(keyA, today, 2);
      assert("S03", again === "false" && (await countOf(keyA, today)) === 2, `a fourth claim = ${again}, count = ${await countOf(keyA, today)}`);

      // -- the first claim opens the row at 1; a cap of 1 refuses the second --
      const first = await claim(keyB, today, 1);
      assert("S04", first === "true" && (await countOf(keyB, today)) === 1, `first claim = ${first}, count = ${await countOf(keyB, today)}`);
      const second = await claim(keyB, today, 1);
      assert("S05", second === "false" && (await countOf(keyB, today)) === 1, `second claim at cap 1 = ${second}, count = ${await countOf(keyB, today)}`);

      // -- a day apart, a key apart --
      const nextDay = await claim(keyA, yesterday, 2);
      assert("S06", nextDay === "true" && (await countOf(keyA, yesterday)) === 1 && (await countOf(keyA, today)) === 2, `same key, other day = ${nextDay}, yesterday = ${await countOf(keyA, yesterday)}, today = ${await countOf(keyA, today)}`);
      const otherKey = await claim(keyC, today, 2);
      assert("S07", otherKey === "true" && (await countOf(keyC, today)) === 1, `other key, same day = ${otherKey}, count = ${await countOf(keyC, today)}`);

      // -- release: named keys, named day only --
      await claim(keyC, today, 2);
      const before = [await countOf(keyA, today), await countOf(keyA, yesterday), await countOf(keyC, today)];
      const r1 = await release([keyA], today);
      const after = [await countOf(keyA, today), await countOf(keyA, yesterday), await countOf(keyC, today)];
      assert("S08", r1 === undefined && before.join() === "2,1,2" && after.join() === "1,1,2", `release A today: ${before.join()} -> ${after.join()}, sqlstate = ${r1 ?? "none"}`);

      const r2 = await release([keyB], today);
      assert("S09", r2 === undefined && (await countOf(keyB, today)) === null, `release a key at 1: sqlstate = ${r2 ?? "none"}, row = ${await countOf(keyB, today)}`);

      await claim(keyB, today, 5);
      await claim(keyB, today, 5);
      await claim(keyB, today, 5);
      const r3 = await release([keyB, keyC, keyA], today);
      const many = [await countOf(keyB, today), await countOf(keyC, today), await countOf(keyA, today), await countOf(keyA, yesterday)];
      assert("S10", r3 === undefined && many[0] === 2 && many[1] === 1 && many[2] === null && many[3] === 1, `release three keys (3, 2, 1 -> 2, 1, none), yesterday kept: ${many.join()}`);

      const snap = await snapshot();
      const r4 = await release([], today);
      assert("S11", r4 === undefined && (await snapshot()) === snap && !snap.startsWith("err"), `empty release: sqlstate = ${r4 ?? "none"}, rows unchanged = ${(await snapshot()) === snap}`);
      const r5 = await release([keyA], yesterday);
      const r6 = await release([keyB], "2020-01-01");
      assert("S12", r5 === undefined && r6 === undefined && (await countOf(keyB, today)) === 2, `release of an absent key/day: ${r5 ?? "none"}, ${r6 ?? "none"}, B today = ${await countOf(keyB, today)}`);

      // -- the table's own shape, privileged so only the CHECK and the key can refuse --
      const lo = await attemptShape(tx, (sp) => sp`insert into goals.sign_in_claims (client_key, day, count) values (${"\\x00"}::bytea, ${today}::date, 0)`);
      const hi = await attemptShape(tx, (sp) => sp`insert into goals.sign_in_claims (client_key, day, count) values (${"\\x01"}::bytea, ${today}::date, 10001)`);
      const top = await attemptShape(tx, (sp) => sp`insert into goals.sign_in_claims (client_key, day, count) values (${"\\x02"}::bytea, ${today}::date, 10000)`);
      const dup = await attemptShape(tx, (sp) => sp`insert into goals.sign_in_claims (client_key, day, count) values (${"\\x02"}::bytea, ${today}::date, 1)`);
      assert("S13", lo.code === "23514" && hi.code === "23514" && top.code === undefined && dup.code === "23505", `count 0 ${shape(lo)}; 10001 ${shape(hi)}; 10000 ${shape(top)}; duplicate key ${shape(dup)}`);

      // -- the catalogue --
      const cat = await attemptRows<{
        rls: boolean; forced: boolean; policies: number; definer: number; pinned: number; fns: number;
        anyone: number; grants: string | null;
      }>(
        tx,
        (sp) => sp`
          select
            (select relrowsecurity from pg_class where oid = 'goals.sign_in_claims'::regclass) as rls,
            (select relforcerowsecurity from pg_class where oid = 'goals.sign_in_claims'::regclass) as forced,
            (select count(*)::int from pg_policies where schemaname = 'goals' and tablename = 'sign_in_claims') as policies,
            (select count(*)::int from pg_proc p where p.pronamespace = 'goals'::regnamespace and p.proname in ('sign_in_claim', 'sign_in_release') and p.prosecdef) as definer,
            (select count(*)::int from pg_proc p where p.pronamespace = 'goals'::regnamespace and p.proname in ('sign_in_claim', 'sign_in_release') and p.proconfig @> array['search_path=""']) as pinned,
            (select count(*)::int from pg_proc p where p.pronamespace = 'goals'::regnamespace and p.proname in ('sign_in_claim', 'sign_in_release')) as fns,
            (select count(*)::int from pg_proc p, unnest(array['public', 'anon', 'authenticated', 'service_role']) r
              where p.pronamespace = 'goals'::regnamespace and p.proname in ('sign_in_claim', 'sign_in_release')
                and has_function_privilege(case when r = 'public' then 0::oid else r::regrole::oid end, p.oid, 'execute')) as anyone,
            (select string_agg(grantee || ':' || privilege_type, ',') from information_schema.role_table_grants
              where table_schema = 'goals' and table_name = 'sign_in_claims'
                and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')) as grants`,
      );
      const c = cat.rows[0];
      assert("S14", cat.code === undefined && c?.rls === true && c.forced === true && c.policies === 0, `sign_in_claims RLS = ${c?.rls ?? "?"}, forced = ${c?.forced ?? "?"}, policies = ${c?.policies ?? "?"}`);
      assert("S15", c?.fns === 2 && c.definer === 2 && c.pinned === 2, `functions = ${c?.fns ?? "?"}, security definer = ${c?.definer ?? "?"}, search_path pinned = ${c?.pinned ?? "?"}`);
      assert("S16", c?.fns === 2 && c.anyone === 0 && c.grants === null, `roles able to execute = ${c?.anyone ?? "?"} (public, anon, authenticated, service_role), table grants = ${c?.grants ?? "none"}`);

      // -- driven: `authenticated` holds USAGE on `goals`, so only the object's own grants answer it --
      await enterUserContext(tx, subject);
      const acts: [string, string, (sp: postgres.TransactionSql) => Promise<{ count: number }>][] = [
        ["S17", "select the table", (sp) => sp`select count from goals.sign_in_claims`],
        ["S18", "run sign_in_claim", (sp) => sp`select goals.sign_in_claim(decode(${keyA}, 'hex'), ${today}::date, 100::integer)`],
        ["S19", "run sign_in_release", (sp) => sp`select goals.sign_in_release(array[decode(${keyA}, 'hex')], ${today}::date)`],
      ];
      for (const [label, act, fn] of acts) {
        const r = await attemptShape(tx, fn);
        assert(label, r.code === "42501", `authenticated ${act}, ${shape(r)}`);
      }
      for (const [label, role] of [["S20", "anon"], ["S21", "service_role"]] as const) {
        for (const [inner, act, fn] of acts) {
          const r = await attemptShape(tx, async (sp) => {
            await sp`select set_config('role', ${role}, true)`;
            return fn(sp);
          });
          assert(`${label}.${inner}`, r.code === "42501", `${role} ${act}, ${shape(r)}`);
        }
      }

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });
  await sql.end();
}

// 0027 (RNP-05): a row hangs only off a parent the person can see. Every
// refusal is the policy's own `42501`, never an FK's `23503`: a uuid that
// exists nowhere must answer exactly as a uuid that belongs to someone else.
async function checkParentOwner0027(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const owner = randomUUID();
  const intruder = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${owner}), (${intruder})`;

      await enterUserContext(tx, owner);
      const a = await seedFixtures(tx, owner);
      const [aTask] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, in_plan)
        values (${owner}, ${a.goalId}, 'tarea ajena', true) returning id`;

      await enterUserContext(tx, intruder);
      const b = await seedFixtures(tx, intruder);

      const refused = async (label: string, what: string, fn: (sp: postgres.TransactionSql) => Promise<unknown>) => {
        const r = await attempt(tx, fn);
        assert(label, r.code === "42501", `${what}, sqlstate = ${r.code ?? "none"}`);
      };

      await refused("O01", "phase on another person's goal", (sp) => sp`
        insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
        values (${intruder}, ${a.goalId}, 'ajena', '2026-01-01', '2026-01-02')`);
      await refused("O02", "month amount on another person's goal", (sp) => sp`
        insert into goals.month_budgets (user_id, goal_id, month, amount)
        values (${intruder}, ${a.goalId}, '2026-11-01', 5)`);
      await refused("O03", "task on another person's goal", (sp) => sp`
        insert into goals.one_offs (user_id, goal_id, name, in_plan)
        values (${intruder}, ${a.goalId}, 'ajena', true)`);
      await refused("O04", "fact on another person's commitment", (sp) => sp`
        insert into goals.facts (user_id, commitment_id, day)
        values (${intruder}, ${a.commitmentId}, '2026-10-01')`);
      await refused("O05", "fact on another person's task", (sp) => sp`
        insert into goals.facts (user_id, one_off_id, day)
        values (${intruder}, ${aTask.id}, '2026-10-01')`);
      await refused("O06", "fact naming another person's goal under an own commitment", (sp) => sp`
        insert into goals.facts (user_id, commitment_id, goal_id, day)
        values (${intruder}, ${b.commitmentId}, ${a.goalId}, '2026-10-02')`);

      // A uuid that exists nowhere is no different from a foreign one.
      const nowhere = randomUUID();
      await refused("O07.phase", "phase on a goal that exists nowhere", (sp) => sp`
        insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
        values (${intruder}, ${nowhere}, 'x', '2026-01-01', '2026-01-02')`);
      await refused("O07.month", "month amount on a goal that exists nowhere", (sp) => sp`
        insert into goals.month_budgets (user_id, goal_id, month, amount)
        values (${intruder}, ${nowhere}, '2026-11-01', 5)`);
      await refused("O07.task", "task on a goal that exists nowhere", (sp) => sp`
        insert into goals.one_offs (user_id, goal_id, name, in_plan)
        values (${intruder}, ${nowhere}, 'x', true)`);
      await refused("O07.commitment", "fact on a commitment that exists nowhere", (sp) => sp`
        insert into goals.facts (user_id, commitment_id, day)
        values (${intruder}, ${nowhere}, '2026-10-03')`);
      await refused("O07.oneoff", "fact on a task that exists nowhere", (sp) => sp`
        insert into goals.facts (user_id, one_off_id, day)
        values (${intruder}, ${nowhere}, '2026-10-03')`);
      await refused("O07.goal", "fact naming a goal that exists nowhere", (sp) => sp`
        insert into goals.facts (user_id, commitment_id, goal_id, day)
        values (${intruder}, ${b.commitmentId}, ${nowhere}, '2026-10-04')`);

      // -- the person's own rows still land --
      const own = async (label: string, what: string, fn: (sp: postgres.TransactionSql) => Promise<{ id: string }[]>) => {
        const r = await attemptRows<{ id: string }>(tx, fn);
        assert(label, r.code === undefined && r.rows.length === 1, `own ${what}, sqlstate = ${r.code ?? "none"}, rows = ${r.rows.length}`);
        return r.rows[0]?.id;
      };
      await own("O08.phase", "phase on own goal", (sp) => sp`
        insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
        values (${intruder}, ${b.goalId}, 'propia', '2026-01-01', '2026-01-02') returning id`);
      await own("O08.month", "month amount on own goal", (sp) => sp`
        insert into goals.month_budgets (user_id, goal_id, month, amount)
        values (${intruder}, ${b.goalId}, '2026-11-01', 5) returning id`);
      const task = await own("O08.task", "task on own goal", (sp) => sp`
        insert into goals.one_offs (user_id, goal_id, name, in_plan)
        values (${intruder}, ${b.goalId}, 'propia', true) returning id`);
      await own("O08.loose", "task on no goal", (sp) => sp`
        insert into goals.one_offs (user_id, name) values (${intruder}, 'suelta') returning id`);
      await own("O08.subtask", "sub-task under own task", (sp) => sp`
        insert into goals.one_offs (user_id, goal_id, name, parent_id)
        values (${intruder}, ${b.goalId}, 'hija', ${task}) returning id`);
      await own("O08.factCommitment", "fact on own commitment and goal", (sp) => sp`
        insert into goals.facts (user_id, commitment_id, goal_id, day)
        values (${intruder}, ${b.commitmentId}, ${b.goalId}, '2026-10-05') returning id`);
      const [lone] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, in_plan)
        values (${intruder}, ${b.goalId}, 'con hecho', true) returning id`;
      await own("O08.factTask", "fact on own task", (sp) => sp`
        insert into goals.facts (user_id, one_off_id, goal_id, day)
        values (${intruder}, ${lone.id}, ${b.goalId}, '2026-10-05') returning id`);

      // -- unchanged: a sub-task under a parent that carries a fact --
      await refused("O09", "sub-task under a parent that carries a fact", (sp) => sp`
        insert into goals.one_offs (user_id, goal_id, name, parent_id)
        values (${intruder}, ${b.goalId}, 'hija tardia', ${lone.id})`);

      // -- the parent must be a plan task of the same goal with no day, no estimate, no parent of its own --
      await own("O10.setup", "sub-task with no estimate under own task", (sp) => sp`
        insert into goals.one_offs (user_id, goal_id, name, parent_id)
        values (${intruder}, ${b.goalId}, 'hija sin estimado', ${task}) returning id`);
      const [subTask] = await tx<{ id: string }[]>`
        select id from goals.one_offs where parent_id = ${task} and name = 'hija sin estimado'`;
      await refused("O10", "sub-task under a sub-task (third level)", (sp) => sp`
        insert into goals.one_offs (user_id, goal_id, name, parent_id)
        values (${intruder}, ${b.goalId}, 'nieta', ${subTask.id})`);

      const [datedInPlan] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, day, in_plan)
        values (${intruder}, ${b.goalId}, 'con dia en plan', '2026-10-05', true) returning id`;
      await refused("O11", "sub-task under a task that has a day, though in plan", (sp) => sp`
        insert into goals.one_offs (user_id, goal_id, name, parent_id)
        values (${intruder}, ${b.goalId}, 'hija de dia', ${datedInPlan.id})`);

      // A task outside the plan with no day: only its day is cleared after the insert, in_plan has no UPDATE grant.
      const [outOfPlan] = await tx<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, day)
        values (${intruder}, ${b.goalId}, 'fuera del plan', '2026-10-06') returning id`;
      await tx`update goals.one_offs set day = null where id = ${outOfPlan.id}`;
      const [outRow] = await tx<{ in_plan: boolean; day: string | null }[]>`
        select in_plan, day from goals.one_offs where id = ${outOfPlan.id}`;
      assert("O12.setup", outRow.in_plan === false && outRow.day === null, `task outside the plan with no day, in_plan = ${outRow.in_plan}, day = ${outRow.day}`);
      await refused("O12", "sub-task under a task outside the plan", (sp) => sp`
        insert into goals.one_offs (user_id, goal_id, name, parent_id)
        values (${intruder}, ${b.goalId}, 'hija de fuera', ${outOfPlan.id})`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });
  await sql.end();
}

// A receipt is what one act answered to one request id (RP-56, RNP-05): the
// person reads and inserts only their own, and no role rewrites or deletes one.
// Driven as `authenticated`, `anon` and `service_role` inside one rollback.
async function checkWriteReceipts0029(): Promise<void> {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const a = randomUUID();
  const b = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${a}), (${b})`;
      const requestId = randomUUID();
      const answer = { goalId: randomUUID(), created: ["meta", "fase"], count: 2 };

      await enterUserContext(tx, a);
      const ownInsert = await attemptRows<{ request_id: string }>(tx, (sp) => sp`
        insert into goals.write_receipts (user_id, request_id, act, answer)
        values (${a}, ${requestId}, 'createGoal', ${sp.json(answer)}) returning request_id`);
      assert("P305", ownInsert.code === undefined && ownInsert.rows.length === 1,
        `A inserts a receipt for A, sqlstate = ${ownInsert.code ?? "none"}, rows = ${ownInsert.rows.length}`);

      const foreignInsert = await attempt(tx, (sp) => sp`
        insert into goals.write_receipts (user_id, request_id, act, answer)
        values (${b}, ${randomUUID()}, 'createGoal', '{}'::jsonb)`);
      assert("P306", foreignInsert.code === "42501",
        `A inserts a receipt with user_id = B, sqlstate = ${foreignInsert.code ?? "none"}`);

      const ownRead = await attemptRows<{ answer: unknown }>(tx, (sp) => sp`
        select answer from goals.write_receipts where request_id = ${requestId}`);
      assert("P307", ownRead.code === undefined && ownRead.rows.length === 1 && isDeepStrictEqual(ownRead.rows[0].answer, answer),
        `A reads its own receipt, sqlstate = ${ownRead.code ?? "none"}, rows = ${ownRead.rows.length}`);

      const update = await attemptCount(tx, (sp) => sp`
        update goals.write_receipts set answer = '{"forged":true}'::jsonb
        where user_id = ${a} and request_id = ${requestId}`);
      assert("P308", update.code === "42501",
        `A rewrites its own receipt's answer, sqlstate = ${update.code ?? "none"}, rows = ${update.count}`);

      const del = await attemptCount(tx, (sp) => sp`
        delete from goals.write_receipts where user_id = ${a} and request_id = ${requestId}`);
      assert("P309", del.code === "42501",
        `A deletes its own receipt, sqlstate = ${del.code ?? "none"}, rows = ${del.count}`);

      const replay = await attempt(tx, (sp) => sp`
        insert into goals.write_receipts (user_id, request_id, act, answer)
        values (${a}, ${requestId}, 'createGoal', '{"second":true}'::jsonb)`);
      assert("P310", replay.code === "23505",
        `A inserts a second receipt for the same request id, sqlstate = ${replay.code ?? "none"}`);

      // `made_at` is the column's `now()`, never the caller's: a receipt dated
      // by hand would dodge or hasten its own prune.
      const dated = await attempt(tx, (sp) => sp`
        insert into goals.write_receipts (user_id, request_id, act, answer, made_at)
        values (${a}, ${randomUUID()}, 'createGoal', '{}'::jsonb, now() - interval '30 days')`);
      assert("P311", dated.code === "42501",
        `A inserts a receipt naming made_at, sqlstate = ${dated.code ?? "none"}`);

      await enterUserContext(tx, b);
      const foreignRead = await attemptRows<{ answer: unknown }>(tx, (sp) => sp`
        select answer from goals.write_receipts where user_id = ${a} or request_id = ${requestId}`);
      assert("P312", foreignRead.code === undefined && foreignRead.rows.length === 0,
        `B selects A's receipt, sqlstate = ${foreignRead.code ?? "none"}, rows = ${foreignRead.rows.length}`);

      const foreignUpdate = await attemptCount(tx, (sp) => sp`
        update goals.write_receipts set answer = '{}'::jsonb where user_id = ${a}`);
      const foreignDelete = await attemptCount(tx, (sp) => sp`
        delete from goals.write_receipts where user_id = ${a}`);
      assert("P313", foreignUpdate.code === "42501" && foreignDelete.code === "42501",
        `B rewrites and deletes A's receipt, update = ${foreignUpdate.code ?? "none"}/${foreignUpdate.count}, delete = ${foreignDelete.code ?? "none"}/${foreignDelete.count}`);

      // The key is the pair: another person may carry the same request id.
      const sameIdOther = await attemptRows<{ request_id: string }>(tx, (sp) => sp`
        insert into goals.write_receipts (user_id, request_id, act, answer)
        values (${b}, ${requestId}, 'createGoal', '{"b":true}'::jsonb) returning request_id`);
      assert("P314", sameIdOther.code === undefined && sameIdOther.rows.length === 1,
        `B inserts its own receipt under A's request id, sqlstate = ${sameIdOther.code ?? "none"}, rows = ${sameIdOther.rows.length}`);

      // From the catalogue, not by a refused query: `anon` and `service_role`
      // hold no USAGE on `goals`, so they are refused with or without a grant.
      const catalogue = await attemptRows<{ anon: boolean; service: boolean; upd: boolean; del: boolean; trunc: boolean }>(tx, (sp) => sp`
        select
          has_table_privilege('anon', 'goals.write_receipts', 'select, insert, update, delete') as anon,
          has_table_privilege('service_role', 'goals.write_receipts', 'select, insert, update, delete') as service,
          has_table_privilege('authenticated', 'goals.write_receipts', 'update') as upd,
          has_table_privilege('authenticated', 'goals.write_receipts', 'delete') as del,
          has_table_privilege('authenticated', 'goals.write_receipts', 'truncate') as trunc`);
      const c = catalogue.rows[0];
      const anonGrants = catalogue.code === undefined ? await privilegesOf(tx, "write_receipts", "anon") : "?";
      const serviceGrants = catalogue.code === undefined ? await privilegesOf(tx, "write_receipts", "service_role") : "?";
      assert("P315",
        catalogue.code === undefined && c !== undefined && !c.anon && !c.service && !c.upd && !c.del && !c.trunc &&
          anonGrants === "" && serviceGrants === "",
        `catalogue, sqlstate = ${catalogue.code ?? "none"}, anon = "${anonGrants}", service_role = "${serviceGrants}", ` +
          `authenticated update/delete/truncate = ${c ? `${c.upd}/${c.del}/${c.trunc}` : "?"}`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });
  await sql.end();

  await checkReceiptAccessor0029();
}

// Drives `lib/receipts.ts` inside a drizzle transaction settled the way
// `withGoalsDb` settles one, counting every statement that reaches the wire.
async function checkReceiptAccessor0029(): Promise<void> {
  let wire = 0;
  const client = postgres(DATABASE_URL!, { prepare: false, max: 1, debug: () => { wire += 1; } });
  const db = drizzle(client, { schema, casing: "snake_case" });
  const a = randomUUID();
  const b = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  let receipts: typeof import("@/lib/receipts");
  try {
    receipts = await import("@/lib/receipts");
  } catch (error) {
    const why = (error as Error).message.split("\n")[0];
    for (const label of ["P316", "P317", "P318", "P319", "P320", "P321", "P322"]) {
      assert(label, false, `lib/receipts.ts does not load: ${why}`);
    }
    await client.end();
    return;
  }
  const { readReceipt, writeReceipt } = receipts;

  await db
    .transaction(async (tx) => {
      const settle = (subject: string) => tx.execute(drizzleSql`select
        set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
        set_config('search_path', 'goals, public', true),
        set_config('role', 'authenticated', true)`);
      await tx.execute(drizzleSql`insert into auth.users (id) values (${a}), (${b})`);
      const aOld = randomUUID();
      const aRecent = randomUUID();
      const bOld = randomUUID();
      // Dated by the owner role: the column grant keeps `made_at` from `authenticated`.
      await tx.execute(drizzleSql`
        insert into goals.write_receipts (user_id, request_id, act, answer, made_at) values
          (${a}, ${aOld}, 'createGoal', '{"age":"8d"}'::jsonb, now() - interval '8 days'),
          (${a}, ${aRecent}, 'createGoal', '{"age":"1d"}'::jsonb, now() - interval '1 day'),
          (${b}, ${bOld}, 'createGoal', '{"age":"8d"}'::jsonb, now() - interval '8 days')`);

      await settle(a);
      const requestId = randomUUID();
      const answer = { goalId: randomUUID(), phases: [{ id: randomUUID(), aim: "Fase 1" }], note: null, count: 3 };

      wire = 0;
      await writeReceipt(tx, a, requestId, "createGoal", answer);
      const writeStatements = wire;
      wire = 0;
      const read = await readReceipt(tx, a, requestId);
      const readStatements = wire;
      assert("P316", isDeepStrictEqual(read, answer),
        `writeReceipt then readReceipt in one tx as A, read = ${JSON.stringify(read)}`);
      assert("P317", writeStatements === 1 && readStatements === 1,
        `one statement each, writeReceipt = ${writeStatements}, readReceipt = ${readStatements}`);

      const missing = await readReceipt(tx, a, randomUUID());
      assert("P318", missing === null, `readReceipt of an id never written, read = ${JSON.stringify(missing)}`);

      // As the owner role every row is in sight, so only the accessor's own
      // filter can keep another person's receipt out of the answer.
      await tx.execute(drizzleSql`reset role`);
      await tx.execute(drizzleSql`
        insert into goals.write_receipts (user_id, request_id, act, answer)
        values (${b}, ${requestId}, 'createGoal', '{"owner":"b"}'::jsonb)`);
      const asA = await readReceipt(tx, a, requestId);
      const asB = await readReceipt(tx, b, requestId);
      const bOnA = await readReceipt(tx, b, aRecent);
      assert("P319",
        isDeepStrictEqual(asA, answer) && isDeepStrictEqual(asB, { owner: "b" }) && bOnA === null,
        `same request id for A and B, A reads ${JSON.stringify(asA)}, B reads ${JSON.stringify(asB)}, B on A's id ${JSON.stringify(bOnA)}`);

      const left = await tx.execute<{ request_id: string }>(drizzleSql`
        select request_id from goals.write_receipts where request_id in (${aOld}, ${aRecent}, ${bOld})`);
      const ids = new Set([...left].map((r) => r.request_id));
      assert("P320", !ids.has(aOld), `A's receipt 8 days old after A writes a new one, still there = ${ids.has(aOld)}`);
      assert("P321", ids.has(aRecent), `A's receipt 1 day old after A writes a new one, still there = ${ids.has(aRecent)}`);
      assert("P322", ids.has(bOld), `B's receipt 8 days old after A writes a new one, still there = ${ids.has(bOld)}`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error === forcedRollback) return;
      assert("P316", false, `accessor run threw: ${pgCode(error) ?? ""} ${(error as Error).message.split("\n")[0]}`);
    });
  await client.end();
}

async function main(): Promise<void> {
  assertSuiteDatabase();
  const sql = postgres(DATABASE_URL!, {
    prepare: false,
    max: 1,
    connection: { search_path: "goals, public" },
  });

  await checkPoliciesAndGrants(sql);
  await sql.end();

  await checkSettleMechanism();
  await checkStatementAttributionByConnection();
  await checkRealClientRejectsBadTokens();
  await checkRealDoor();
  await checkOneOffDeleteGrant();
  await checkOneOffWithFactRefusedByPolicy();
  await checkGoalRenameArchiveGrant();
  await checkOneOffScheduleAndHorizonGrants();
  await checkScheduledOneOffMoveByZone();
  await checkPlanByMonth();
  await checkAiDoor();
  await checkTaskNote();
  await checkPlanOrder();
  await checkPlanOrderBackfillTieBreak();
  await checkCommitmentPositionPerPerson();
  await checkGoalAndOneOffPositionPerPerson();
  await checkRoadmapSchema();
  await checkAuditoria0015();
  await checkConnectionHost0016();
  await checkGoalTree0018();
  await checkModelCallsChat0020();
  await checkNoEndAndLoose0021();
  await checkCommitmentName0022();
  await checkCommitmentClosedColumns();
  await checkDeleteAndEdit0025();
  await checkAllowedEmails0025();
  await checkSignInClaims0026();
  await checkParentOwner0027();
  await checkWriteReceipts0029();

  if (failed) process.exit(1);
}

main();
