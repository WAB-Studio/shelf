// Proves RNP-03 and RNP-04 against the seeded person, the way
// `scripts/harness/seed-goal.ts` reaches a server action: by stubbing the
// three modules that only exist inside Next (`server-only`, `next/headers`,
// `next/cache`) before the first `@/`-rooted import, and by redeeming the
// same `private/session-<lane>.json` cookie `mint-session.ts` left standing.
// Nothing here fabricates a claim — `getPerson()` sees exactly the identity
// that cookie names.
//
// The statement count comes from the driver, not from reading `day.ts`:
// `postgres`'s own `debug` option fires once for every statement it puts on
// the wire, `begin` and `commit` included (`apps/homefund/scripts/harness/
// instrument.ts`'s own technique). The done criterion names "four
// statements... two settles and two queries", so `begin`/`commit` are
// counted off the wire and then excluded before the assertion — they are a
// round trip each, but never a statement `day.ts` chose to send. Excluding
// them is bounded, not blind: each connection must bracket exactly one
// `begin` and one `commit`, never a `rollback` and never a second one of
// either — an extra transaction-control statement is itself a round trip
// `day.ts` did not choose to spend, and independent validation found this
// file originally let it hide inside the very count it was supposed to
// bound. Every run asserts the bracket, cold included, and the overlap is
// decided by call order (`./plan/wire.ts`), never by timestamps.
// The type-fetch `postgres` sends on a connection's first-ever use is netted
// out the same bounded way, by an exact match on its own text (never a bare
// substring, which let a statement merely mentioning `pg_catalog.pg_type`
// net itself out too) and capped at one per connection, zero on every warm
// run. Five consecutive warm calls are asserted, not one or two: a fix that
// only holds for the first couple is a fix a later screen the same minute
// would still be paying for.
//
// The degraded scenario needs a fresh module graph: `lib/evidence/
// registry.ts` builds its reader map once, at import time, and a process
// that already ran the real reader cannot un-import it. This file re-execs
// itself as a child with `--degraded-child`, the one place `./reading-
// lookups` is stubbed to reject, and reads the child's one line of JSON back.
import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";

// The session pooler, loaded here before `installStubs` runs so it is never
// the wrapped, counted `postgres` — used only to delete a probe's own goal.
import postgres from "postgres";

import { proveOverlap, wrapPostgres, type DebugCall, type PostgresFactory } from "./plan/wire";

function laneNumber(): number {
  const raw = process.env.HARNESS_LANE?.trim();
  if (!raw) return 1;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`HARNESS_LANE must be a positive integer, not "${raw}"`);
  }
  return Number(raw);
}

const lane = laneNumber();

function sessionFile(): string {
  return resolve(process.cwd(), `private/session-${lane}.json`);
}

type StoredCookie = { name: string; value: string };

// `mint-session.ts`'s own file, read the same way `seed-goal.ts` reads it.
function loadCookies(): StoredCookie[] {
  const file = sessionFile();
  let state: { cookies: StoredCookie[] };
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`no session at ${file} — run harness:mint-session first`);
  }
  if (state.cookies.length === 0) {
    throw new Error(`${file} carries no cookie — the mint did not land one`);
  }
  return state.cookies.map(({ name, value }) => ({ name, value }));
}

// The user id the cookie's access token names, read off the token's own
// payload: the session file outlives `auth.users` rows a reset or a reap
// removed, and `loadDay` answers that with a message about a missing session.
function sessionUserId(cookies: StoredCookie[]): string {
  // The landing also leaves cookies that are not the session, such as the signed-in marker.
  const value = cookies
    .filter((cookie) => cookie.name.includes("-auth-token"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((cookie) => cookie.value)
    .join("");
  try {
    const session = JSON.parse(Buffer.from(value.replace(/^base64-/, ""), "base64url").toString("utf8"));
    const payload = JSON.parse(
      Buffer.from(String(session.access_token).split(".")[1], "base64url").toString("utf8"),
    );
    if (typeof payload.sub !== "string") throw new Error("no sub");
    return payload.sub;
  } catch {
    throw new Error(
      `${sessionFile()} carries a cookie that is not a session: re-mint (HARNESS_LANE=${lane} npm run harness:mint-session)`,
    );
  }
}

async function assertSessionUserExists(cookies: StoredCookie[]): Promise<void> {
  const userId = sessionUserId(cookies);
  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const rows = await db`select 1 from auth.users where id = ${userId}`;
    if (rows.length === 0) {
      throw new Error(
        `session user ${userId} does not exist: re-mint (HARNESS_LANE=${lane} npm run harness:mint-session)`,
      );
    }
  } finally {
    await db.end();
  }
}

const wireCalls: DebugCall[] = [];

/**
 * Installs every stub `@/lib/queries/day.ts`'s own import chain needs to run
 * outside Next, `installReadingLookupsStub` included when `degraded` is true.
 * Has to run before the first `@/`-rooted import — `seed-goal.ts`'s own
 * warning, word for word: `_load` binds each `require` once, and a module
 * already required is a module this cannot reach again.
 */
function installStubs(cookies: StoredCookie[], degraded: boolean): void {
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;

  untyped._load = (request, parent, isMain) => {
    if (request === "server-only") return {};
    if (request === "next/headers") {
      return { cookies: async () => ({ getAll: () => cookies, set() {} }) };
    }
    if (request === "next/cache") {
      return { revalidatePath() {} };
    }
    // The one reader `lib/evidence/registry.ts` names today (RNP-10). Only
    // that file imports this relative specifier, so matching the bare string
    // carries no risk of catching an unrelated module.
    if (degraded && request === "./reading-lookups") {
      return {
        readReadingLookups: async () => {
          throw new Error("check-day.ts: simulated reading-lookups failure");
        },
      };
    }
    // Wraps `postgres` itself once, so every statement `db/client.ts`'s pool
    // sends is counted — `prepare`, `max` and `idle_timeout` pass through
    // untouched, the pool under measurement stays the pool `loadDay` gets.
    if (request === "postgres") {
      const real = originalLoad(request, parent, isMain) as PostgresFactory;
      return wrapPostgres(real, (call) => wireCalls.push(call));
    }
    return originalLoad(request, parent, isMain);
  };
}

function normalizeStatement(query: string): string {
  return query.trim().toLowerCase();
}

// `postgres`'s own default `fetch_types: true` (never set in `db/client.ts`,
// and this file must not set it either) sends exactly this query the first
// time a physical connection is ever used — read verbatim off
// `node_modules/postgres/src/connection.js`'s own `fetchArrayTypes`, not
// guessed at. An exact match on the whole statement, whitespace collapsed:
// a bare `pg_catalog.pg_type` substring match let a statement that merely
// *mentions* that catalog (independent validation's own
// `select count(*) from pg_catalog.pg_type`) net itself out of the count
// it was supposed to inflate.
const TYPE_FETCH_QUERY_TEXT =
  "select b.oid, b.typarray from pg_catalog.pg_type a left join pg_catalog.pg_type b " +
  "on b.oid = a.typelem where a.typcategory = 'a' group by b.oid, b.typarray order by b.oid";

function isTypeFetchText(query: string): boolean {
  return query.replace(/\s+/g, " ").trim().toLowerCase() === TYPE_FETCH_QUERY_TEXT;
}

// The UTC instant that reads as `hour:minute` in `zone` on `day` — read off
// `Intl`'s own offset for that day (`timeZoneName: "longOffset"`, e.g.
// "GMT-05:00"), never a hardcoded "-05:00": the same authority `lib/zone.ts`
// already defers every civil-day render to. One pass is exact for a zone
// whose offset does not move within a day, which is all this ever asks of it.
function instantAtLocalTime(day: string, hour: number, minute: number, zone: string): Date {
  const offsetText = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date(`${day}T12:00:00Z`))
    .find((part) => part.type === "timeZoneName")?.value;

  const match = offsetText ? /^GMT([+-])(\d{2}):(\d{2})$/.exec(offsetText) : null;
  if (!match) throw new Error(`instantAtLocalTime: unreadable offset "${offsetText}" for ${zone}`);
  const [, sign, offsetHours, offsetMinutes] = match;
  const offsetMinutesTotal =
    (sign === "-" ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes));

  const instant = new Date(`${day}T00:00:00Z`);
  instant.setUTCMinutes(instant.getUTCMinutes() + hour * 60 + minute - offsetMinutesTotal);
  return instant;
}

// The settle's `search_path` is the schema `withGoalsDb`/`withReadingDb` chose
// (`lib/session.ts`). It rides inlined in the settle's text
// (`lib/settled-transaction.ts`), so the statement carries no parameters.
function labelConnection(calls: DebugCall[]): string {
  const settle = calls.find((call) => /set_config/i.test(call.query));
  const searchPath = /set_config\('search_path',\s*'([^']*)'/i.exec(settle?.query ?? "")?.[1] ?? "";
  if (searchPath.startsWith("goals")) return "goals";
  if (searchPath.startsWith("reading")) return "reading";
  return "unknown";
}

function groupByConnection(calls: DebugCall[]): Map<number, DebugCall[]> {
  const groups = new Map<number, DebugCall[]>();
  for (const call of calls) {
    const list = groups.get(call.connection) ?? [];
    list.push(call);
    groups.set(call.connection, list);
  }
  return groups;
}

type GroupAnalysis = {
  connection: number;
  label: string;
  beginCount: number;
  commitCount: number;
  rollbackCount: number;
  typeFetchCount: number;
  // Net of the transaction's own bracket and of the type-fetch `postgres`
  // sends on a connection's first-ever use — what `day.ts` itself chose to
  // send, and the only number the "four" assertion is about.
  applicationCount: number;
  bracketOk: boolean;
};

function analyzeGroup(connection: number, calls: DebugCall[]): GroupAnalysis {
  const label = labelConnection(calls);

  const beginCount = calls.filter((call) => normalizeStatement(call.query).startsWith("begin")).length;
  const commitCount = calls.filter((call) => normalizeStatement(call.query) === "commit").length;
  const rollbackCount = calls.filter((call) => normalizeStatement(call.query) === "rollback").length;
  const typeFetchCount = calls.filter((call) => isTypeFetchText(call.query)).length;
  const applicationCount = calls.length - beginCount - commitCount - rollbackCount - typeFetchCount;
  const bracketOk = beginCount === 1 && commitCount === 1 && rollbackCount === 0;

  return { connection, label, beginCount, commitCount, rollbackCount, typeFetchCount, applicationCount, bracketOk };
}

let failed = false;

// Goals the older probes create: `goals` grants the app no DELETE, so
// `runMain` removes them over the migration connection once every probe ran.
const probeGoalIds: string[] = [];

function assert(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!ok) failed = true;
}

/**
 * Prints every connection's own window, bracket and statement counts, and
 * asserts on all of it: every connection brackets exactly one `begin` and
 * one `commit`, never a `rollback`, never a second one of either (an extra
 * transaction-control statement is a round trip `day.ts` did not choose to
 * spend, and hiding inside a blind filter is the hole independent
 * validation found); at most one type-fetch statement per connection, and
 * on a warm run none at all — a connection warm enough to be reused has
 * already paid that cost, so a second sighting of it is itself a defect,
 * never a fact to net out a second time; the application statements, net of
 * that bracket and of any legitimate type-fetch, total exactly four —
 * asserted on the cold run too, not only the warm ones; and, only when
 * the caller passed `overlap`, the second transaction started while the
 * first was held (`proveOverlap`: decided by call order, no clock). The cold
 * run proves it too; `isWarm` only gates the zero-type-fetch assertion.
 */
function reportRun(label: string, calls: DebugCall[], isWarm: boolean, overlap?: OverlapOutcome): void {
  const groups = [...groupByConnection(calls).entries()].map(([connection, groupCalls]) =>
    analyzeGroup(connection, groupCalls),
  );

  const totalApplication = groups.reduce((sum, group) => sum + group.applicationCount, 0);
  const totalTypeFetch = groups.reduce((sum, group) => sum + group.typeFetchCount, 0);

  console.log(
    `\n${label} run — ${calls.length} statement(s) on the wire across ${groups.length} connection(s), ` +
      `${totalApplication} application statement(s), ${totalTypeFetch} type-fetch statement(s)`,
  );
  for (const group of groups) {
    console.log(
      `  ${group.label.padEnd(8)} cid=${group.connection} ` +
        `begin=${group.beginCount} commit=${group.commitCount} rollback=${group.rollbackCount}, ` +
        `application=${group.applicationCount}, type-fetch=${group.typeFetchCount}`,
    );
  }

  const badBrackets = groups.filter((group) => !group.bracketOk);
  assert(
    `${label} run's connections bracket exactly one begin and one commit, no rollback`,
    badBrackets.length === 0,
    badBrackets.length === 0
      ? `${groups.length} connection(s), each begin=1 commit=1 rollback=0`
      : badBrackets
          .map(
            (group) =>
              `cid=${group.connection} (${group.label}) begin=${group.beginCount} commit=${group.commitCount} rollback=${group.rollbackCount}`,
          )
          .join("; "),
  );

  const overCapped = groups.filter((group) => group.typeFetchCount > 1);
  assert(
    `${label} run's connections send at most one type-fetch statement each`,
    overCapped.length === 0,
    overCapped.length === 0
      ? `${groups.length} connection(s), each type-fetch <= 1`
      : overCapped.map((group) => `cid=${group.connection} (${group.label}) type-fetch=${group.typeFetchCount}`).join("; "),
  );

  if (isWarm) {
    const unexpectedTypeFetch = groups.filter((group) => group.typeFetchCount > 0);
    assert(
      `${label} run's connections send no type-fetch statement`,
      unexpectedTypeFetch.length === 0,
      unexpectedTypeFetch.length === 0
        ? `${groups.length} connection(s), each type-fetch = 0`
        : unexpectedTypeFetch
            .map((group) => `cid=${group.connection} (${group.label}) type-fetch=${group.typeFetchCount}`)
            .join("; "),
    );
  }

  assert(
    `${label} run issues four application statements, no more`,
    totalApplication === 4,
    `${totalApplication} application statement(s) of ${calls.length} on the wire, ${totalTypeFetch} netted out as type-fetch`,
  );

  if (overlap) {
    assert(
      `${label} run's two transactions overlap: the second starts while the first is held`,
      overlap.ok,
      overlap.ok ? "the second began before the first was released" : overlap.detail,
    );
  }
}

type OverlapOutcome = { ok: boolean; detail: string };

// Runs one loader with its first transaction held; a chained loader never asks
// for the second, so the deadline turns into a failed assertion, not a hang.
async function withOverlap<T>(run: () => Promise<T>): Promise<{ result: T; overlap: OverlapOutcome }> {
  let result!: T;
  let loaderError: unknown;
  try {
    await proveOverlap(
      async () => {
        try {
          result = await run();
        } catch (error) {
          loaderError = error;
        }
      },
      { deadlineMs: 10_000 },
    );
  } catch (error) {
    return { result, overlap: { ok: false, detail: error instanceof Error ? error.message : String(error) } };
  }
  if (loaderError) throw loaderError;
  return { result, overlap: { ok: true, detail: "" } };
}

type DegradedResult = { evidence: string; slotIds: string[] };

// The child's whole report: one line, so a stray `console.log` upstream of it
// (Next's own, a dependency's) never gets parsed as the result.
const DEGRADED_MARKER = "DEGRADED_JSON ";

// The goals transaction's own two statements (its settle, its query) plus
// the reading transaction's one (its settle alone). Measured, not assumed:
// `withReadingDb`'s settle always runs, unconditionally, before `fn(tx)`
// does (`lib/session.ts`'s `withSettledDb`); the stub this file installs for
// `./reading-lookups` throws before it ever touches `tx`, so nothing of the
// reader's own reaches the wire. `sql.begin` answers a thrown callback with
// `rollback`, never `commit` (`node_modules/postgres/src/index.js`'s own
// `begin()`), so the reading connection's bracket is begin+rollback, not
// begin+commit — RNP-03's bound on the failure path is not the happy path's
// shape, but it is still a bound, and this is what a real run of it sends.
const EXPECTED_DEGRADED_APPLICATION_STATEMENTS = 3;

/**
 * The degraded child spawns fresh every time (`runDegradedChildProcess`), so
 * both its connections are cold — each may pay one type-fetch, capped the
 * same way the main run's cold call is. Asserts the goals connection's usual
 * bracket, the reading connection's rolled-back one, and the total
 * application-statement count — the hole independent validation found:
 * `runDegradedChild` counted nothing of its own, so a real extra round trip
 * on the failure path went unnoticed while `REPORT passed`.
 */
function reportDegradedRun(calls: DebugCall[]): void {
  const groups = [...groupByConnection(calls).entries()].map(([connection, groupCalls]) =>
    analyzeGroup(connection, groupCalls),
  );

  const totalApplication = groups.reduce((sum, group) => sum + group.applicationCount, 0);
  const totalTypeFetch = groups.reduce((sum, group) => sum + group.typeFetchCount, 0);

  console.log(
    `\ndegraded child's own wire — ${calls.length} statement(s) across ${groups.length} connection(s), ` +
      `${totalApplication} application statement(s), ${totalTypeFetch} type-fetch statement(s)`,
  );
  for (const group of groups) {
    console.log(
      `  ${group.label.padEnd(8)} cid=${group.connection} begin=${group.beginCount} commit=${group.commitCount} ` +
        `rollback=${group.rollbackCount}, application=${group.applicationCount}, type-fetch=${group.typeFetchCount}`,
    );
  }

  const overCapped = groups.filter((group) => group.typeFetchCount > 1);
  assert(
    "degraded child's connections send at most one type-fetch statement each",
    overCapped.length === 0,
    overCapped.length === 0
      ? `${groups.length} connection(s), each type-fetch <= 1`
      : overCapped.map((group) => `cid=${group.connection} (${group.label}) type-fetch=${group.typeFetchCount}`).join("; "),
  );

  const goalsGroups = groups.filter((group) => group.label === "goals");
  const readingGroups = groups.filter((group) => group.label === "reading");
  assert(
    "degraded child opens exactly one goals connection and one reading connection",
    groups.length === 2 && goalsGroups.length === 1 && readingGroups.length === 1,
    `${groups.length} connection(s): ${groups.map((group) => group.label).join(", ") || "none"}`,
  );

  const goals = goalsGroups[0];
  if (goals) {
    assert(
      "degraded child's goals connection brackets exactly one begin and one commit, no rollback",
      goals.beginCount === 1 && goals.commitCount === 1 && goals.rollbackCount === 0,
      `begin=${goals.beginCount} commit=${goals.commitCount} rollback=${goals.rollbackCount}`,
    );
  }

  const reading = readingGroups[0];
  if (reading) {
    assert(
      "degraded child's reading connection brackets exactly one begin and one rollback, no commit",
      reading.beginCount === 1 && reading.commitCount === 0 && reading.rollbackCount === 1,
      `begin=${reading.beginCount} commit=${reading.commitCount} rollback=${reading.rollbackCount}`,
    );
  }

  assert(
    `degraded child issues ${EXPECTED_DEGRADED_APPLICATION_STATEMENTS} application statements, no more`,
    totalApplication === EXPECTED_DEGRADED_APPLICATION_STATEMENTS,
    `${totalApplication} application statement(s) of ${calls.length} on the wire, ${totalTypeFetch} netted out as type-fetch`,
  );
}

async function runDegradedChild(): Promise<void> {
  installStubs(loadCookies(), true);

  const { loadDay } = await import("@/lib/queries/day");
  const { todayInZone } = await import("@/lib/zone");

  const start = wireCalls.length;
  const { view, evidence } = await loadDay(todayInZone());
  reportDegradedRun(wireCalls.slice(start));

  const result: DegradedResult = {
    evidence,
    slotIds: view.slots.map((slot) => slot.commitmentId).sort(),
  };
  console.log(`${DEGRADED_MARKER}${JSON.stringify(result)}`);
}

function runDegradedChildProcess(): DegradedResult {
  let output: string;
  try {
    output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--env-file=.env.local", "scripts/check-day.ts", "--degraded-child"],
      { cwd: process.cwd(), env: process.env, encoding: "utf8" },
    );
  } catch (error) {
    // The child's own PASS/FAIL lines are on its stdout, lost the moment
    // `execFileSync` throws unless printed here — the only place a caller of
    // this function still has them.
    const execError = error as { stdout?: string; stderr?: string; message: string };
    if (execError.stdout) console.log(execError.stdout);
    if (execError.stderr) console.error(execError.stderr);
    throw new Error(`degraded child process failed: ${execError.message}`);
  }
  console.log(output);
  const line = output.split("\n").find((row) => row.startsWith(DEGRADED_MARKER));
  if (!line) throw new Error(`degraded child printed no result:\n${output}`);
  return JSON.parse(line.slice(DEGRADED_MARKER.length)) as DegradedResult;
}

// `ZONE_TEST_DAY` (a Sunday) and `ZONE_NEXT_DAY` (the Monday right after it,
// so it is also that week's own `weekStart`) are years before any date the
// rest of this file ever asks for — retired, this row can never resurface in
// the cold/warm/degraded assertions above, which all ask for `today` alone,
// and neither `goals` nor `commitments` grant a DELETE at all, so it is never
// cleaned up; picked once, reused by every run of this suite.
const ZONE_TEST_DAY = "2019-11-03";
const ZONE_NEXT_DAY = "2019-11-04";

/**
 * Proves `lib/queries/day.ts`'s and `lib/queries/week.ts`'s own `retired_at`
 * filter reads the person's civil day, not the session's (UTC): a commitment
 * retired at 23:30 in `TIME_ZONE` on `ZONE_TEST_DAY` is 04:30 UTC on
 * `ZONE_NEXT_DAY` — a bare `retired_at::date` renders that as `ZONE_NEXT_DAY`
 * already, one day early.
 *
 * `loadDay` proves the day-level filter: `ZONE_TEST_DAY >= ZONE_TEST_DAY`
 * passes either way, so the defect never shows there — it is `ZONE_NEXT_DAY`
 * where a bare cast wrongly keeps `retired_at::date (= ZONE_NEXT_DAY) >=
 * ZONE_NEXT_DAY` true, asking one day too many.
 *
 * `loadWeek` proves the coarser week-level filter at its own `weekStart`
 * (`ZONE_NEXT_DAY` here, a Monday): retired the Sunday before its week
 * begins, the commitment must never enter that week's set at all. A bare
 * cast renders `retired_at::date` as `ZONE_NEXT_DAY` too, so
 * `>= weekStart` wrongly passes and the row rides into every day `deriveWeek`
 * derives, `asksOn`'s own retirement check included — that check compares a
 * civil day against `plan.retiredAt`'s full timestamp string and does not
 * block a `daily` cadence here, so the leak reaches `view.days` as a slot on
 * `ZONE_NEXT_DAY` itself under the bug, and never gets that far under the fix.
 *
 * Built through the app's own doors (`createGoal`, `addCommitment`) and one
 * raw `UPDATE` for the one column their grant ever lets move afterward
 * (`GRANT UPDATE (retired_at)`, `db/migrations/0000_mighty_pet_avengers.sql`)
 * — never a privileged connection.
 */
async function runZoneCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { loadWeek } = await import("@/lib/queries/week");
  const { createGoal, addCommitment } = await import("@/app/actions/plan");
  const { getPerson, withGoalsDb } = await import("@/lib/session");
  const { TIME_ZONE } = await import("@/lib/zone");
  const { sql } = await import("drizzle-orm");

  const person = await getPerson();
  if (!person) throw new Error("runZoneCheck: no verified session");

  const goal = await createGoal({ name: "check-day zone probe", horizon: "2099-12-31" });
  if (!goal.ok) throw new Error(`runZoneCheck: createGoal failed: ${goal.error}`);
  probeGoalIds.push(goal.goalId);

  const commitment = await addCommitment({
    goalId: goal.goalId,
    name: "check-day zone probe",
    cadenceKind: "daily",
    satisfaction: "tap",
  });
  if (!commitment.ok) throw new Error(`runZoneCheck: addCommitment failed: ${commitment.error}`);
  const testId = commitment.commitmentId;

  await backdateCommitment(testId, person.id, new Date("2019-01-01T12:00:00Z"));

  const retiredAt = instantAtLocalTime(ZONE_TEST_DAY, 23, 30, TIME_ZONE);
  await withGoalsDb((tx) =>
    tx.execute(
      sql`update "goals"."commitments" set retired_at = ${retiredAt.toISOString()}::timestamptz where id = ${testId}`,
    ),
  );

  const onRetirementDay = await loadDay(ZONE_TEST_DAY);
  const dayAfter = await loadDay(ZONE_NEXT_DAY);
  const presentOn = onRetirementDay.commitments.some((row) => row.id === testId);
  const presentAfter = dayAfter.commitments.some((row) => row.id === testId);
  assert(
    "loadDay still asks for a commitment on the civil day it was retired",
    presentOn,
    `commitment ${presentOn ? "present" : "absent"} in loadDay("${ZONE_TEST_DAY}")`,
  );
  assert(
    "loadDay stops asking for it the very next civil day",
    !presentAfter,
    `commitment ${presentAfter ? "present" : "absent"} in loadDay("${ZONE_NEXT_DAY}")`,
  );

  const week = await loadWeek(ZONE_NEXT_DAY);
  const weekStartDay = week.view.days.find((day) => day.day === ZONE_NEXT_DAY);
  if (!weekStartDay) throw new Error(`runZoneCheck: loadWeek derived no day "${ZONE_NEXT_DAY}"`);
  const presentInWeek = weekStartDay.slots.some((slot) => slot.commitmentId === testId);
  assert(
    "loadWeek never admits a commitment retired the civil day before its week starts",
    !presentInWeek,
    `commitment ${presentInWeek ? "present" : "absent"} on loadWeek("${ZONE_NEXT_DAY}")'s own "${ZONE_NEXT_DAY}"`,
  );
}

// A Wednesday in the same week `runZoneCheck` already uses (Monday
// `ZONE_NEXT_DAY` .. Sunday), so `loadWeek` derives the same seven days from
// a single fresh call, no new commitment span to reason about.
const CADENCE_ZONE_WEDNESDAY = "2019-11-06";

/**
 * Proves `lib/day/cadence.ts`'s own `asksOn`, never `lib/queries/week.ts`'s
 * SQL filter: retired mid-week, this commitment is `>= weekStart` regardless
 * of which zone `retired_at::date` renders in, so it always rides into
 * `deriveWeek`'s raw commitments set — the SQL filter does not touch this
 * case at all. What used to decide Thursday–Sunday was `asksOn`'s own bare
 * `day > plan.retiredAt` — a civil-date string compared lexically against a
 * full ISO instant, which a Thursday date string reads as "not yet retired"
 * for exactly the reason `lib/queries/day.ts` did: the instant's own UTC
 * render lands on Thursday, and a bare compare never looks past that.
 */
async function runCadenceZoneCheck(): Promise<void> {
  const { loadWeek } = await import("@/lib/queries/week");
  const { createGoal, addCommitment } = await import("@/app/actions/plan");
  const { getPerson, withGoalsDb } = await import("@/lib/session");
  const { TIME_ZONE } = await import("@/lib/zone");
  const { sql } = await import("drizzle-orm");

  const person = await getPerson();
  if (!person) throw new Error("runCadenceZoneCheck: no verified session");

  const goal = await createGoal({ name: "check-day cadence zone probe", horizon: "2099-12-31" });
  if (!goal.ok) throw new Error(`runCadenceZoneCheck: createGoal failed: ${goal.error}`);
  probeGoalIds.push(goal.goalId);

  const commitment = await addCommitment({
    goalId: goal.goalId,
    name: "check-day cadence zone probe",
    cadenceKind: "daily",
    satisfaction: "tap",
  });
  if (!commitment.ok) {
    throw new Error(`runCadenceZoneCheck: addCommitment failed: ${commitment.error}`);
  }
  const testId = commitment.commitmentId;

  await backdateCommitment(testId, person.id, new Date("2019-01-01T12:00:00Z"));

  const retiredAt = instantAtLocalTime(CADENCE_ZONE_WEDNESDAY, 23, 30, TIME_ZONE);
  await withGoalsDb((tx) =>
    tx.execute(
      sql`update "goals"."commitments" set retired_at = ${retiredAt.toISOString()}::timestamptz where id = ${testId}`,
    ),
  );

  const week = await loadWeek(CADENCE_ZONE_WEDNESDAY);
  const askedDays = new Set(
    week.view.days
      .filter((day) => day.slots.some((slot) => slot.commitmentId === testId))
      .map((day) => day.day),
  );

  assert(
    "loadWeek still asks on the Wednesday a commitment was retired at 23:30 Bogotá",
    askedDays.has(CADENCE_ZONE_WEDNESDAY),
    `asked days: [${[...askedDays].join(", ")}]`,
  );
  const daysAfter = week.view.days
    .map((day) => day.day)
    .filter((day) => day > CADENCE_ZONE_WEDNESDAY);
  assert(
    "loadWeek asks on no day from Thursday through Sunday of that same week",
    daysAfter.every((day) => !askedDays.has(day)),
    `asked days: [${[...askedDays].join(", ")}], days after Wednesday: [${daysAfter.join(", ")}]`,
  );
}

/**
 * Proves `lib/queries/week.ts`'s own `loadWeek(...).commitments` — the raw
 * `CommitmentGoal[]` the screen groups a week's dots under, built
 * straight off `row.commitments` and never passed through `asksOn` — carries
 * the same zone fix `runZoneCheck` proved on `view.days` alone. A commitment
 * retired at 23:30 Bogotá on `ZONE_TEST_DAY` (a Sunday) must be gone from
 * `loadWeek(ZONE_NEXT_DAY)`'s own list: `deriveWeek`'s `asksOn` would still
 * keep this commitment out of every day's slots even under a bare
 * `retired_at::date` cast (`ZONE_TEST_DAY` sits in the week before), so that
 * check alone cannot catch a filter regressed back to the bare cast — only
 * reading `commitments` itself, before `asksOn` ever runs, can.
 */
async function runWeekCommitmentsZoneCheck(): Promise<void> {
  const { loadWeek } = await import("@/lib/queries/week");
  const { createGoal, addCommitment } = await import("@/app/actions/plan");
  const { getPerson, withGoalsDb } = await import("@/lib/session");
  const { TIME_ZONE } = await import("@/lib/zone");
  const { sql } = await import("drizzle-orm");

  const person = await getPerson();
  if (!person) throw new Error("runWeekCommitmentsZoneCheck: no verified session");

  const goal = await createGoal({ name: "check-day week-commitments zone probe", horizon: "2099-12-31" });
  if (!goal.ok) throw new Error(`runWeekCommitmentsZoneCheck: createGoal failed: ${goal.error}`);
  probeGoalIds.push(goal.goalId);

  const commitment = await addCommitment({
    goalId: goal.goalId,
    name: "check-day week-commitments zone probe",
    cadenceKind: "daily",
    satisfaction: "tap",
  });
  if (!commitment.ok) {
    throw new Error(`runWeekCommitmentsZoneCheck: addCommitment failed: ${commitment.error}`);
  }
  const testId = commitment.commitmentId;

  const retiredAt = instantAtLocalTime(ZONE_TEST_DAY, 23, 30, TIME_ZONE);
  await withGoalsDb((tx) =>
    tx.execute(
      sql`update "goals"."commitments" set retired_at = ${retiredAt.toISOString()}::timestamptz where id = ${testId}`,
    ),
  );

  const week = await loadWeek(ZONE_NEXT_DAY);
  const presentInCommitments = week.commitments.some((row) => row.id === testId);
  assert(
    "loadWeek's own commitments list never admits a commitment retired the civil day before its week starts",
    !presentInCommitments,
    `commitment ${presentInCommitments ? "present" : "absent"} in loadWeek("${ZONE_NEXT_DAY}").commitments`,
  );
}

// A commitment asks nothing before its own `created_at`'s civil day, so a
// probe about a day in the past writes that moment back by id, under the
// identity that owns the row. The app's own role cannot write the column.
async function backdateCommitment(id: string, userId: string, createdAt: Date): Promise<void> {
  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    await db`
      update goals.commitments set created_at = ${createdAt.toISOString()}::timestamptz
      where id = ${id} and user_id = ${userId}
    `;
  } finally {
    await db.end();
  }
}

// Whole civil days added to a `YYYY-MM-DD` string, by midday UTC — the same
// technique `scripts/harness/seed-goal.ts` and `lib/zone.ts`'s own `weekOf`
// use.
function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(date);
}

// The Monday of the week that starts at least `days` after `after` — always
// strictly later than `after` itself, whatever civil day `after` names.
function mondayAtLeastAfter(after: string, days: number): string {
  const candidate = addDays(after, days);
  const weekday = new Date(`${candidate}T12:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  const backToMonday = weekday === 0 ? 6 : weekday - 1;
  return addDays(candidate, -backToMonday);
}

/**
 * A Monday later than any phase this identity's own probes have ever seeded
 * (`goals.phases` grants no DELETE — RP-15 has no retirement of its own —
 * so every past run's own phase is still live), plus a further random offset
 * so two runs racing this check never land on the same day either. A fixed
 * or independently-random day both failed here: a fixed day accumulates one
 * phase per run forever, and `deriveWeek`'s own `phaseOn` keeps only the
 * first phase covering a day when two overlap it, so a later run compared
 * against a stranger's own already-seeded phase, never the one it just made
 * — and a day chosen independent of what already exists still falls, most of
 * the time, inside an earlier run's own wide `[2017-12-01, ends_on]` span,
 * for the same reason. Confirmed by running this check twice in a row before
 * this fix, both showing the same, wrong, already-seeded phase.
 */
async function pickFreshPhaseMonday(): Promise<string> {
  const { withGoalsDb } = await import("@/lib/session");
  const { sql } = await import("drizzle-orm");

  const [row] = await withGoalsDb((tx) =>
    tx.execute<{ max_ends_on: string | null }>(
      sql`select max(ends_on) as max_ends_on from "goals"."phases"`,
    ),
  );
  const floor = row?.max_ends_on ?? "1970-01-05";
  const anchor = mondayAtLeastAfter(floor, 7);
  return addDays(anchor, randomInt(0, 500) * 7);
}

/**
 * Proves `lib/queries/week.ts`'s own `p.ends_on >= weekStart` bound: a phase
 * ending exactly on the week's own Monday must still be that Monday's phase
 * in `loadWeek`'s own view — the row-selection layer this bound guards,
 * never `phaseOn`'s own inclusive check (`runMain`'s cold/warm calls and
 * `lib/day/derive.test.ts` cover that half; a phase excluded from the row set
 * entirely never reaches `phaseOn` to be misjudged either way).
 */
async function runPhaseWeekBoundCheck(): Promise<void> {
  const { loadWeek } = await import("@/lib/queries/week");
  const { createGoal, addPhase } = await import("@/app/actions/plan");

  const monday = await pickFreshPhaseMonday();

  const goal = await createGoal({ name: "check-day phase week-bound probe", horizon: "2099-12-31" });
  if (!goal.ok) throw new Error(`runPhaseWeekBoundCheck: createGoal failed: ${goal.error}`);
  probeGoalIds.push(goal.goalId);

  const phase = await addPhase({
    goalId: goal.goalId,
    aim: "check-day phase week-bound probe",
    startsOn: addDays(monday, -7),
    endsOn: monday,
  });
  if (!phase.ok) throw new Error(`runPhaseWeekBoundCheck: addPhase failed: ${phase.error}`);

  const week = await loadWeek(monday);
  const mondayView = week.view.days.find((day) => day.day === monday);
  if (!mondayView) {
    throw new Error(`runPhaseWeekBoundCheck: loadWeek derived no day "${monday}"`);
  }

  assert(
    "a phase ending on a week's own Monday is in that week's loadWeek phases (RP-15)",
    mondayView.phase?.id === phase.phaseId,
    `phase = ${JSON.stringify(mondayView.phase)}`,
  );
}

/**
 * Proves `loadDay`'s own `view.slots[].satisfied`, which neither `runMain`'s
 * own cold/warm assertions nor `check:goal` ever read (both stop at slot ids,
 * statement counts and measure totals — independent validation's own
 * mutation over `lib/queries/day.ts`'s fact filter survived exactly this
 * blind spot). A tap commitment's slot for today starts unsatisfied and
 * flips the moment `declareFact` writes today's fact — the one round trip a
 * person's own tap actually drives.
 */
async function runFactSatisfactionCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { createGoal, addCommitment } = await import("@/app/actions/plan");
  const { declareFact } = await import("@/app/actions/facts");
  const { todayInZone } = await import("@/lib/zone");

  const today = todayInZone();
  const goal = await createGoal({ name: "check-day fact-satisfaction probe", horizon: "2099-12-31" });
  if (!goal.ok) throw new Error(`runFactSatisfactionCheck: createGoal failed: ${goal.error}`);
  probeGoalIds.push(goal.goalId);

  const commitment = await addCommitment({
    goalId: goal.goalId,
    name: "check-day fact-satisfaction probe",
    cadenceKind: "daily",
    satisfaction: "tap",
  });
  if (!commitment.ok) {
    throw new Error(`runFactSatisfactionCheck: addCommitment failed: ${commitment.error}`);
  }
  const testId = commitment.commitmentId;

  const before = await loadDay(today);
  const slotBefore = before.view.slots.find((slot) => slot.commitmentId === testId);
  assert(
    "a tap commitment with no fact declared today has an unsatisfied slot",
    slotBefore?.satisfied === false,
    `slot = ${JSON.stringify(slotBefore)}`,
  );

  const fact = await declareFact({ commitmentId: testId });
  if (!fact.ok) throw new Error(`runFactSatisfactionCheck: declareFact failed: ${fact.error}`);

  const after = await loadDay(today);
  const slotAfter = after.view.slots.find((slot) => slot.commitmentId === testId);
  assert(
    "declaring a fact makes that commitment's slot for today satisfied",
    slotAfter?.satisfied === true,
    `slot = ${JSON.stringify(slotAfter)}`,
  );
}

/**
 * Proves `declareFact`'s own refusal (RP-05, `app/actions/facts.ts`): a fact
 * for a commitment satisfied by evidence would have no day of its own to
 * explain, since that day is drawn from the source, never written here.
 * `day-row.tsx`'s own `tappable = kind !== "evidence"` means no screen ever
 * sends this call, so this is the one place today that reaches it at all.
 */
async function runEvidenceRefusalCheck(): Promise<void> {
  const { createGoal, addCommitment } = await import("@/app/actions/plan");
  const { declareFact } = await import("@/app/actions/facts");

  const goal = await createGoal({ name: "check-day evidence-refusal probe", horizon: "2099-12-31" });
  if (!goal.ok) throw new Error(`runEvidenceRefusalCheck: createGoal failed: ${goal.error}`);
  probeGoalIds.push(goal.goalId);

  const commitment = await addCommitment({
    goalId: goal.goalId,
    name: "check-day evidence-refusal probe",
    cadenceKind: "daily",
    satisfaction: "evidence",
    sourceKey: "reading_lookups",
    threshold: 1,
  });
  if (!commitment.ok) {
    throw new Error(`runEvidenceRefusalCheck: addCommitment failed: ${commitment.error}`);
  }

  const result = await declareFact({ commitmentId: commitment.commitmentId });
  assert(
    "declareFact refuses a fact for a commitment satisfied by evidence (RP-05)",
    !result.ok && result.error === "day.errors.evidenceOnly",
    JSON.stringify(result),
  );
}

/**
 * Proves that: a `tap` commitment holds at most one fact
 * a day, whatever the device. Two concurrent `declareFact` calls race on the
 * pool (`max: 8`, `db/client.ts`), so `Promise.all` genuinely opens two
 * connections rather than one queued behind the other — the shape the
 * assignment names, not a stand-in for it.
 *
 * The raw second insert bypasses `declareFact`'s own `on conflict … do
 * nothing` on purpose: it is the negative control for the index itself,
 * proved as the person under RLS (`withGoalsDb`, never a privileged
 * connection) rather than asserted from the migration (`AGENTS.md`
 * «## Code»).
 */
async function runFactUniqueCheck(): Promise<void> {
  const { createGoal, addCommitment } = await import("@/app/actions/plan");
  const { declareFact } = await import("@/app/actions/facts");
  const { getPerson, withGoalsDb } = await import("@/lib/session");
  const { todayInZone } = await import("@/lib/zone");
  const { facts } = await import("@/db/schema");
  const { pgCode } = await import("@/lib/db-error");
  const { sql } = await import("drizzle-orm");

  const person = await getPerson();
  if (!person) throw new Error("runFactUniqueCheck: no verified session");

  const goal = await createGoal({ name: "check-day unique-fact probe", horizon: "2099-12-31" });
  if (!goal.ok) throw new Error(`runFactUniqueCheck: createGoal failed: ${goal.error}`);
  probeGoalIds.push(goal.goalId);

  const commitment = await addCommitment({
    goalId: goal.goalId,
    name: "check-day unique-fact probe",
    cadenceKind: "daily",
    satisfaction: "tap",
  });
  if (!commitment.ok) {
    throw new Error(`runFactUniqueCheck: addCommitment failed: ${commitment.error}`);
  }
  const testId = commitment.commitmentId;
  const today = todayInZone();

  const [first, second] = await Promise.all([
    declareFact({ commitmentId: testId }),
    declareFact({ commitmentId: testId }),
  ]);
  assert(
    "two concurrent declareFact calls for the same tap commitment and day both report ok",
    first.ok && second.ok,
    `first = ${JSON.stringify(first)}, second = ${JSON.stringify(second)}`,
  );

  const [{ count }] = await withGoalsDb((tx) =>
    tx.execute<{ count: string }>(
      sql`select count(*)::int as count from ${facts} where commitment_id = ${testId} and day = ${today}`,
    ),
  );
  assert(
    "two concurrent declareFact calls for the same commitment and day leave exactly one fact",
    Number(count) === 1,
    `count = ${count}`,
  );

  let rawInsertCode: string | undefined;
  try {
    await withGoalsDb((tx) =>
      tx.execute(sql`
        insert into ${facts} (user_id, commitment_id, one_off_id, goal_id, day)
        values (${person.id}, ${testId}, null, ${goal.goalId}, ${today})
      `),
    );
  } catch (error) {
    // `pgCode` (`@/lib/db-error`): `PgPreparedQuery#queryWithCache`
    // (`pg-core/session.ts`) wraps the raw `postgres` error in a
    // `DrizzleQueryError`, whose own `.code` is undefined — the code that
    // matters is on `.cause`, the real driver error.
    rawInsertCode = pgCode(error);
  }
  assert(
    "a raw second insert for the same commitment and day fails with the unique violation (23505)",
    rawInsertCode === "23505",
    `code = ${rawInsertCode ?? "none — the insert succeeded"}`,
  );
}

/**
 * Proves that `declareFact`'s own advisory lock
 * (`app/actions/facts.ts`) serialises "Cambiar" (`replace: true`) racing a
 * plain tap on the same commitment and day. Before the lock, an independent
 * validator drove this live and found 11 of 20 trials where the loser's own
 * fallback `select` (after `on conflict … do nothing`) read a row the
 * winner's own delete had already removed by the time either transaction
 * committed — a `factId` that no longer exists is worse than an error, since
 * nothing on screen ever finds out.
 *
 * Each trial has its own fresh commitment, so one trial's race can never
 * contaminate another's — but every trial's pair is fired in the same
 * `Promise.all`, all `TRIALS * 2` calls at once, not one trial at a time.
 * Sequential trials never reproduced the bug in this environment (0 of 70,
 * measured): each trial's two calls raced each other, but the pool sat idle
 * between trials, and this script's own round trips to Supabase are close
 * enough in latency that one trial alone rarely lands the exact interleaving
 * the bug needs (`declareFact`'s comment above spells out which one). Firing
 * every trial's pair together reproduces the real contention an independent
 * validator saw driving this live through the app, where many requests
 * genuinely overlap on the connection pool (`db/client.ts`'s own `max: 8`).
 */
async function runReplaceRaceCheck(): Promise<void> {
  const { createGoal, addCommitment } = await import("@/app/actions/plan");
  const { declareFact } = await import("@/app/actions/facts");
  const { withGoalsDb } = await import("@/lib/session");
  const { todayInZone } = await import("@/lib/zone");
  const { facts } = await import("@/db/schema");
  const { sql } = await import("drizzle-orm");

  const TRIALS = 10;
  // `tap` trials adopt an identical row instead of deleting it (`declareFact`'s
  // own "adopts first"), so they cannot show a missing lock alone: the lock's
  // own work is two "Cambiar" calls with different quantities, where the
  // second must read the first's row and replace it, never conflict into it.
  const QUANTITY_TRIALS = 20;
  const today = todayInZone();

  const goal = await createGoal({ name: "check-day replace-race probe", horizon: "2099-12-31" });
  if (!goal.ok) throw new Error(`runReplaceRaceCheck: createGoal failed: ${goal.error}`);
  probeGoalIds.push(goal.goalId);

  const made = await Promise.all(
    Array.from({ length: TRIALS + QUANTITY_TRIALS }, (_, trial) =>
      addCommitment(
        trial < TRIALS
          ? {
              goalId: goal.goalId,
              name: `check-day replace-race probe ${trial}`,
              cadenceKind: "daily",
              satisfaction: "tap",
            }
          : {
              goalId: goal.goalId,
              name: `check-day replace-race probe ${trial}`,
              cadenceKind: "daily",
              satisfaction: "quantity",
              targetQuantity: 1,
              unit: "min",
            },
      ),
    ),
  );
  const ids = made.map((commitment) => {
    if (!commitment.ok) {
      throw new Error(`runReplaceRaceCheck: addCommitment failed: ${commitment.error}`);
    }
    return commitment.commitmentId;
  });
  const testIds = ids.slice(0, TRIALS);
  const quantityIds = ids.slice(TRIALS);

  type Call = {
    testId: string;
    quantity: number | null;
    result: Awaited<ReturnType<typeof declareFact>>;
  };
  const calls: Promise<Call>[] = [
    ...testIds.flatMap((testId) => [
      declareFact({ commitmentId: testId }).then((result) => ({ testId, quantity: null, result })),
      declareFact({ commitmentId: testId, replace: true }).then((result) => ({
        testId,
        quantity: null,
        result,
      })),
    ]),
    ...quantityIds.flatMap((testId) =>
      [1, 2].map((quantity) =>
        declareFact({ commitmentId: testId, quantity, replace: true }).then((result) => ({
          testId,
          quantity,
          result,
        })),
      ),
    ),
  ];
  const raceStart = Date.now();
  const settled = await Promise.all(calls);
  console.log(`replace race — ${calls.length} concurrent call(s) settled in ${Date.now() - raceStart}ms`);

  for (const { testId, result } of settled) {
    if (!result.ok) {
      throw new Error(`runReplaceRaceCheck: a call for ${testId} failed: ${JSON.stringify(result)}`);
    }
  }

  let multiRowTrials = 0;
  let deadIdTrials = 0;
  let foreignQuantityTrials = 0;

  for (const testId of [...testIds, ...quantityIds]) {
    const rows = await withGoalsDb((tx) =>
      tx.execute<{ id: string; quantity: number | null }>(
        sql`select id, quantity from ${facts} where commitment_id = ${testId} and day = ${today}`,
      ),
    );
    if (rows.length !== 1) multiRowTrials++;

    const liveIds = new Set(rows.map((row) => row.id));
    const trialCalls = settled.filter((call) => call.testId === testId);
    const returnedIds = trialCalls.map((call) => (call.result as { ok: true; factId: string }).factId);
    if (testIds.includes(testId) && returnedIds.some((factId) => !liveIds.has(factId))) {
      deadIdTrials++;
    }

    // A "Cambiar" that answers with the row still standing must have written
    // what it was asked to: answering with the other call's row is the lost
    // update an unserialised pair produces.
    if (quantityIds.includes(testId)) {
      const standing = rows[0];
      const foreign = trialCalls.some((call) => {
        const factId = (call.result as { ok: true; factId: string }).factId;
        return standing !== undefined && factId === standing.id && standing.quantity !== call.quantity;
      });
      if (foreign) foreignQuantityTrials++;
    }
  }

  assert(
    `${TRIALS + QUANTITY_TRIALS} replace-vs-plain trials each leave exactly one row for their own commitment and day`,
    multiRowTrials === 0,
    `${multiRowTrials} of ${TRIALS + QUANTITY_TRIALS} trial(s) left more than one row`,
  );
  assert(
    `${TRIALS} replace-vs-plain trials never return a factId that is not the row left standing`,
    deadIdTrials === 0,
    `${deadIdTrials} of ${TRIALS} trial(s) returned a dead factId`,
  );
  assert(
    `${QUANTITY_TRIALS} replace-vs-replace trials never answer with the standing row of a call that wrote another quantity`,
    foreignQuantityTrials === 0,
    `${foreignQuantityTrials} of ${QUANTITY_TRIALS} trial(s) answered with a row carrying the other call's quantity`,
  );
}

/**
 * Proves RP-19 widened: `loadDay(today).oneOffs` carries a
 * one-off dated three days back, still undone, with its own `day`; drops one
 * dated three days back whose fact was written on a day other than today —
 * "done leaves the list for good", true on any day the fact was written, not
 * only today's; and never carries one dated tomorrow. Built through
 * `createOneOff` (`app/actions/one-offs.ts`) for every row, plus one raw
 * insert for the "got a fact yesterday" case: a fact dated
 * yesterday is seeded raw here, the way `runZoneCheck` above already seeds state
 * `declareFact` cannot reach. The `loadDay(today)` call itself is wrapped in
 * `reportRun` the same way the cold/warm calls in `runMain` are, so the
 * carrying oneOffs list and the four-statement count are proven from the
 * very same call. Cleaned up by the ids this function returns: the fact
 * first (`facts_delete_self`), then every one-off (`one_offs_delete_self`,
 * which refuses a row that still carries a fact).
 */
async function runOneOffCarryCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { createOneOff } = await import("@/app/actions/one-offs");
  const { getPerson, withGoalsDb } = await import("@/lib/session");
  const { todayInZone } = await import("@/lib/zone");
  const { facts, oneOffs } = await import("@/db/schema");
  const { sql } = await import("drizzle-orm");

  const person = await getPerson();
  if (!person) throw new Error("runOneOffCarryCheck: no verified session");

  const today = todayInZone();
  const threeDaysBack = addDays(today, -3);
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);

  // `createOneOff` refuses a past day (RP-19), so the rows dated back are raw inserts.
  async function seedDated(name: string, day: string): Promise<{ oneOffId: string }> {
    const [row] = await withGoalsDb((tx) =>
      tx.execute<{ id: string }>(sql`
        insert into ${oneOffs} (user_id, goal_id, name, day)
        values (${person!.id}, null, ${name}, ${day})
        returning id
      `),
    );
    return { oneOffId: row.id };
  }
  const undone = await seedDated("check-day carry probe undone", threeDaysBack);
  const doneElsewhen = await seedDated("check-day carry probe done-elsewhen", threeDaysBack);

  const future = await createOneOff({ name: "check-day carry probe future", day: tomorrow });
  if (!future.ok) {
    throw new Error(`runOneOffCarryCheck: createOneOff (future) failed: ${future.error}`);
  }

  const [factRow] = await withGoalsDb((tx) =>
    tx.execute<{ id: string }>(sql`
      insert into ${facts} (user_id, commitment_id, one_off_id, goal_id, day)
      values (${person.id}, null, ${doneElsewhen.oneOffId}, null, ${yesterday})
      returning id
    `),
  );

  const start = wireCalls.length;
  const day = await loadDay(today);
  reportRun("carry", wireCalls.slice(start), false);

  const ids = day.oneOffs.map((oneOff) => oneOff.id);
  const undoneRow = day.oneOffs.find((oneOff) => oneOff.id === undone.oneOffId);

  assert(
    "loadDay(today).oneOffs carries a one-off dated three days back, still undone, with its own day",
    undoneRow !== undefined && undoneRow.day === threeDaysBack,
    `row = ${JSON.stringify(undoneRow)}`,
  );
  assert(
    "loadDay(today).oneOffs drops a one-off whose fact was written on a day other than today",
    !ids.includes(doneElsewhen.oneOffId),
    `ids = ${JSON.stringify(ids)}`,
  );
  assert(
    "loadDay(today).oneOffs never carries a one-off dated tomorrow",
    !ids.includes(future.oneOffId),
    `ids = ${JSON.stringify(ids)}`,
  );

  await withGoalsDb((tx) => tx.execute(sql`delete from ${facts} where id = ${factRow.id}`));
  await withGoalsDb((tx) =>
    tx.execute(
      sql`delete from ${oneOffs} where id in (${undone.oneOffId}, ${doneElsewhen.oneOffId}, ${future.oneOffId})`,
    ),
  );
}

/**
 * Proves RP-06 for `LoggedFact.writtenOn` (`lib/day/logged-fact.ts`): a fact
 * dated `yesterday` but inserted right now reads back from
 * `loadDay(yesterday)` with `writtenOn` — today's own civil day, read
 * through `civilDateInZone`, never a bare substring of `writtenAt` — never
 * the day the fact explains. `declareFact` cannot seed this state for a
 * fresh commitment: `requireDayForSubject` refuses a `day` before the
 * commitment's own `createdDay`, which a commitment created moments ago
 * always is, so the raw insert below is the only way to reach a fact whose
 * own day and whose own written moment fall on two different civil days.
 */
async function runFactWrittenOnCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { createGoal, addCommitment } = await import("@/app/actions/plan");
  const { getPerson, withGoalsDb } = await import("@/lib/session");
  const { todayInZone } = await import("@/lib/zone");
  const { facts } = await import("@/db/schema");
  const { sql } = await import("drizzle-orm");

  const person = await getPerson();
  if (!person) throw new Error("runFactWrittenOnCheck: no verified session");

  const today = todayInZone();
  const yesterday = addDays(today, -1);

  const goal = await createGoal({ name: "check-day written-on probe", horizon: "2099-12-31" });
  if (!goal.ok) throw new Error(`runFactWrittenOnCheck: createGoal failed: ${goal.error}`);
  probeGoalIds.push(goal.goalId);

  const commitment = await addCommitment({
    goalId: goal.goalId,
    name: "check-day written-on probe",
    cadenceKind: "daily",
    satisfaction: "tap",
  });
  if (!commitment.ok) {
    throw new Error(`runFactWrittenOnCheck: addCommitment failed: ${commitment.error}`);
  }
  const testId = commitment.commitmentId;

  await backdateCommitment(testId, person.id, new Date(Date.now() - 3 * 86_400_000));

  const [factRow] = await withGoalsDb((tx) =>
    tx.execute<{ id: string }>(sql`
      insert into ${facts} (user_id, commitment_id, one_off_id, goal_id, day)
      values (${person.id}, ${testId}, null, ${goal.goalId}, ${yesterday})
      returning id
    `),
  );

  const day = await loadDay(yesterday);
  const logged = day.factsByCommitment[testId];

  assert(
    "a fact written today for yesterday comes back from loadDay(yesterday) with writtenOn = today",
    logged !== undefined && logged.writtenOn === today,
    `logged = ${JSON.stringify(logged)}`,
  );

  const slot = day.view.slots.find((candidate) => candidate.commitmentId === testId);
  assert(
    "that same fact satisfies the commitment's own slot on the day it explains (yesterday)",
    slot?.satisfied === true,
    `slot = ${JSON.stringify(slot)}`,
  );

  await withGoalsDb((tx) => tx.execute(sql`delete from ${facts} where id = ${factRow.id}`));
}

/**
 * Proves `lib/queries/day.ts`'s own `p.ends_on >= day` bound: a phase ending
 * on day D is in `loadDay(D).phases`. The week-bound check above proves the
 * same edge for `loadWeek`; this is `loadDay`'s own statement.
 */
async function runPhaseDayBoundCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { createGoal, addPhase } = await import("@/app/actions/plan");

  const endsOn = await pickFreshPhaseMonday();

  const goal = await createGoal({ name: "check-day phase day-bound probe", horizon: "2099-12-31" });
  if (!goal.ok) throw new Error(`runPhaseDayBoundCheck: createGoal failed: ${goal.error}`);

  const migrationDb = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const phase = await addPhase({
      goalId: goal.goalId,
      aim: "check-day phase day-bound probe",
      startsOn: addDays(endsOn, -7),
      endsOn,
    });
    if (!phase.ok) throw new Error(`runPhaseDayBoundCheck: addPhase failed: ${phase.error}`);

    const day = await loadDay(endsOn);
    assert(
      "a phase ending on day D is in loadDay(D).phases (RP-15)",
      day.phases.some((candidate) => candidate.id === phase.phaseId),
      `phases = ${JSON.stringify(day.phases.map((candidate) => candidate.id))}, wanted ${phase.phaseId}`,
    );
  } finally {
    await migrationDb`delete from goals.goals where id = ${goal.goalId}`;
    await migrationDb.end();
  }
}

/**
 * Proves `daylessCount` counts only the dayless (RP-59), against a baseline
 * read first, with two dayless and one dated-undone one-off so the two sets
 * differ in size, and that `listDaylessOneOffs` reads them oldest first.
 */
async function runDaylessCountAndOrderCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { listDaylessOneOffs } = await import("@/lib/queries/one-offs");
  const { getPerson, withGoalsDb } = await import("@/lib/session");
  const { todayInZone } = await import("@/lib/zone");
  const { oneOffs } = await import("@/db/schema");
  const { sql } = await import("drizzle-orm");

  const person = await getPerson();
  if (!person) throw new Error("runDaylessCountAndOrderCheck: no verified session");

  const today = todayInZone();
  const baseline = (await loadDay(today)).daylessCount;
  const ids: string[] = [];

  async function seed(name: string, day: string | null): Promise<string> {
    const [row] = await withGoalsDb((tx) =>
      tx.execute<{ id: string }>(sql`
        insert into ${oneOffs} (user_id, goal_id, name, day)
        values (${person!.id}, null, ${name}, ${day})
        returning id
      `),
    );
    ids.push(row.id);
    return row.id;
  }

  try {
    const first = await seed("check-day order first", null);
    const second = await seed("check-day order second", null);
    await seed("check-day dated undone a", today);

    const now = await loadDay(today);
    assert(
      "daylessCount moves by the two dayless one-offs, not by the dated one",
      now.daylessCount === baseline + 2,
      `baseline ${baseline}, now ${now.daylessCount}`,
    );

    const listed = (await listDaylessOneOffs()).map((row) => row.id);
    assert(
      "listDaylessOneOffs lists the older dayless one-off before the newer",
      listed.indexOf(first) !== -1 && listed.indexOf(first) < listed.indexOf(second),
      `first at ${listed.indexOf(first)}, second at ${listed.indexOf(second)}`,
    );
  } finally {
    if (ids.length > 0) {
      await withGoalsDb((tx) =>
        tx.execute(sql`delete from ${oneOffs} where id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`),
      );
    }
  }
}

/**
 * Proves that a commitment asks nothing before the civil day it
 * was written (`loadDay` and `loadWeek` alike), `loadDay(today).goals` carries
 * `openedOn`, a one-off done on the day drawn is in `doneOneOffs` with its
 * fact and out of `oneOffs`, one done yesterday is in neither, and a dayless
 * one is in neither list but counts in `daylessCount` and is listed by
 * `listDaylessOneOffs`, unless it is done or belongs to a goal (RP-59: a
 * goal's task waits in its plan). The dayless
 * count is measured against a baseline read first: this identity may hold
 * dayless rows of its own. Every row is deleted by id in `finally`.
 */
async function runCreatedOnAndOneOffsCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { loadWeek } = await import("@/lib/queries/week");
  const { listDaylessOneOffs } = await import("@/lib/queries/one-offs");
  const { createGoal, addCommitment, archiveGoal } = await import("@/app/actions/plan");
  const { createOneOff, completeOneOff } = await import("@/app/actions/one-offs");
  const { getPerson, withGoalsDb } = await import("@/lib/session");
  const { todayInZone } = await import("@/lib/zone");
  const { oneOffs } = await import("@/db/schema");
  const { sql } = await import("drizzle-orm");

  const person = await getPerson();
  if (!person) throw new Error("runCreatedOnAndOneOffsCheck: no verified session");

  const today = todayInZone();
  const yesterday = addDays(today, -1);
  const baseline = (await loadDay(today)).daylessCount;

  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const goalIds: string[] = [];
  const oneOffIds: string[] = [];

  async function seedDayless(name: string, goalId: string | null): Promise<string> {
    const [row] = await withGoalsDb((tx) =>
      tx.execute<{ id: string }>(sql`
        insert into ${oneOffs} (user_id, goal_id, name, day)
        values (${person!.id}, ${goalId}, ${name}, null)
        returning id
      `),
    );
    oneOffIds.push(row.id);
    return row.id;
  }

  try {
    const goal = await createGoal({ name: "check-day created-on probe", horizon: "2099-12-31" });
    if (!goal.ok) throw new Error(`runCreatedOnAndOneOffsCheck: createGoal failed: ${goal.error}`);
    goalIds.push(goal.goalId);

    const commitment = await addCommitment({
      goalId: goal.goalId,
      name: "check-day created-on probe",
      cadenceKind: "daily",
      satisfaction: "tap",
    });
    if (!commitment.ok) {
      throw new Error(`runCreatedOnAndOneOffsCheck: addCommitment failed: ${commitment.error}`);
    }
    const commitmentId = commitment.commitmentId;

    const doneToday = await createOneOff({ name: "check-day done today", day: today, goalId: goal.goalId });
    if (!doneToday.ok) throw new Error("runCreatedOnAndOneOffsCheck: createOneOff failed");
    // A past day is refused by `createOneOff` (RP-19), so this row is a raw insert.
    const [doneYesterdayRow] = await withGoalsDb((tx) =>
      tx.execute<{ id: string }>(sql`
        insert into ${oneOffs} (user_id, goal_id, name, day)
        values (${person.id}, null, 'check-day done yesterday', ${yesterday})
        returning id
      `),
    );
    const doneYesterday = { oneOffId: doneYesterdayRow.id };
    const undoneToday = await createOneOff({ name: "check-day undone today", day: today });
    if (!undoneToday.ok) throw new Error("runCreatedOnAndOneOffsCheck: createOneOff (undone) failed");
    oneOffIds.push(doneToday.oneOffId, doneYesterday.oneOffId, undoneToday.oneOffId);

    const completed = await completeOneOff({ oneOffId: doneToday.oneOffId });
    if (!completed.ok) throw new Error(`runCreatedOnAndOneOffsCheck: completeOneOff failed: ${completed.error}`);
    await db`
      insert into goals.facts (user_id, commitment_id, one_off_id, goal_id, day)
      values (${person.id}, null, ${doneYesterday.oneOffId}, null, ${yesterday})
    `;

    const dayless = await seedDayless("check-day dayless", null);
    const daylessDone = await seedDayless("check-day dayless done", null);
    const daylessDoneResult = await completeOneOff({ oneOffId: daylessDone });
    if (!daylessDoneResult.ok) {
      throw new Error(`runCreatedOnAndOneOffsCheck: completeOneOff (dayless) failed: ${daylessDoneResult.error}`);
    }
    const archivedGoal = await createGoal({ name: "check-day archived probe", horizon: "2099-12-31" });
    if (!archivedGoal.ok) throw new Error(`runCreatedOnAndOneOffsCheck: createGoal failed: ${archivedGoal.error}`);
    goalIds.push(archivedGoal.goalId);
    const daylessArchived = await seedDayless("check-day dayless archived", archivedGoal.goalId);
    const archived = await archiveGoal({ goalId: archivedGoal.goalId });
    if (!archived.ok) throw new Error(`runCreatedOnAndOneOffsCheck: archiveGoal failed: ${archived.error}`);

    const start = wireCalls.length;
    const todayDay = await loadDay(today);
    reportRun("created-on", wireCalls.slice(start), false);
    const yesterdayDay = await loadDay(yesterday);

    assert(
      "a commitment created today is absent from loadDay(yesterday).view.slots",
      !yesterdayDay.view.slots.some((slot) => slot.commitmentId === commitmentId),
      `slots = ${JSON.stringify(yesterdayDay.view.slots.map((slot) => slot.commitmentId))}`,
    );
    assert(
      "it is present on its own day, in loadDay(today).view.slots",
      todayDay.view.slots.some((slot) => slot.commitmentId === commitmentId),
      `slots = ${JSON.stringify(todayDay.view.slots.map((slot) => slot.commitmentId))}`,
    );

    const week = await loadWeek(yesterday);
    const weekYesterday = week.view.days.find((day) => day.day === yesterday);
    const weekToday = (await loadWeek(today)).view.days.find((day) => day.day === today);
    assert(
      "loadWeek asks nothing for that commitment on the day before its creation",
      weekYesterday !== undefined && !weekYesterday.slots.some((slot) => slot.commitmentId === commitmentId),
      `slots = ${JSON.stringify(weekYesterday?.slots.map((slot) => slot.commitmentId))}`,
    );
    assert(
      "loadWeek asks for it on its own day",
      weekToday !== undefined && weekToday.slots.some((slot) => slot.commitmentId === commitmentId),
      `slots = ${JSON.stringify(weekToday?.slots.map((slot) => slot.commitmentId))}`,
    );

    const openedOn = todayDay.goals.find((candidate) => candidate.id === goal.goalId)?.openedOn;
    assert("loadDay(today).goals carries openedOn, the civil day the goal was written", openedOn === today, `openedOn = ${openedOn}`);

    const [factRow] = await db<{ id: string }[]>`
      select id from goals.facts where one_off_id = ${doneToday.oneOffId}
    `;
    const doneRow = todayDay.doneOneOffs.find((row) => row.id === doneToday.oneOffId);
    assert(
      "a one-off completed today is in doneOneOffs with its factId",
      doneRow !== undefined && doneRow.factId === factRow.id && doneRow.goalId === goal.goalId,
      `row = ${JSON.stringify(doneRow)}, fact ${factRow.id}`,
    );
    assert(
      "it is not in oneOffs",
      !todayDay.oneOffs.some((row) => row.id === doneToday.oneOffId),
      "checked against loadDay(today).oneOffs",
    );
    const listed = [...todayDay.oneOffs.map((row) => row.id), ...todayDay.doneOneOffs.map((row) => row.id)];
    assert(
      "a one-off completed yesterday is in neither list",
      !listed.includes(doneYesterday.oneOffId),
      `ids = ${JSON.stringify(listed)}`,
    );
    assert(
      "a dayless one-off is in neither list",
      !listed.includes(dayless),
      `ids = ${JSON.stringify(listed)}`,
    );
    assert(
      "daylessCount counts the dayless one, and not a dated one, a done one nor one whose goal is archived",
      todayDay.daylessCount === baseline + 1,
      `baseline ${baseline}, now ${todayDay.daylessCount}`,
    );

    const listStart = wireCalls.length;
    const daylessList = await listDaylessOneOffs();
    const listCalls = wireCalls.slice(listStart);
    const ids = daylessList.map((row) => row.id);
    assert(
      "listDaylessOneOffs lists the dayless one and no dated, done or archived-goal one",
      ids.includes(dayless) &&
        !ids.includes(undoneToday.oneOffId) &&
        !ids.includes(daylessDone) &&
        !ids.includes(daylessArchived),
      `ids = ${JSON.stringify(ids)}`,
    );
    assert(
      "listDaylessOneOffs and daylessCount agree",
      daylessList.length === todayDay.daylessCount,
      `${daylessList.length} listed, ${todayDay.daylessCount} counted`,
    );
    const listApplication = [...groupByConnection(listCalls).entries()].reduce(
      (sum, [connection, calls]) => sum + analyzeGroup(connection, calls).applicationCount,
      0,
    );
    assert(
      "listDaylessOneOffs issues two application statements",
      listApplication === 2,
      `${listApplication} application statement(s) of ${listCalls.length} on the wire`,
    );
  } finally {
    if (oneOffIds.length > 0) {
      await db`delete from goals.one_offs where id in ${db(oneOffIds)} and user_id = ${person.id}`;
    }
    if (goalIds.length > 0) {
      await db`delete from goals.goals where id in ${db(goalIds)} and user_id = ${person.id}`;
    }
    await db.end();
  }
}

function applicationStatements(calls: DebugCall[]): number {
  return [...groupByConnection(calls).entries()].reduce(
    (sum, [connection, group]) => sum + analyzeGroup(connection, group).applicationCount,
    0,
  );
}

// An ended goal leaves the day, the week keeps the days it lived,
// a done one-off carries its time, scheduled one-offs are counted and
// listed, the week's measure equals the goal's own current week. Every row
// is seeded under this run's identity and deleted by id. Run alone with
// `--module-74`.
async function runEndedGoalScheduledCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { loadWeek } = await import("@/lib/queries/week");
  const { loadGoal } = await import("@/lib/queries/goal");
  const { listDaylessOneOffs, listScheduledOneOffs } = await import("@/lib/queries/one-offs");
  const { tallyDays } = await import("@/lib/day/tally");
  const { getPerson } = await import("@/lib/session");
  const { todayInZone, weekOf } = await import("@/lib/zone");

  const person = await getPerson();
  if (!person) throw new Error("runEndedGoalScheduledCheck: no verified session");
  const userId = person.id;

  const today = todayInZone();
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);
  const monday = weekOf(today)[0];
  console.log(`\nmodule 74 check — ${new Date().toISOString()} (today ${today}, monday ${monday})`);

  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const goalIds: string[] = [];
  const oneOffIds: string[] = [];

  async function seedGoal(
    name: string,
    horizon: string,
    measure: { name: string; unit: string } | null,
    archived = false,
    createdAt: string | null = null,
  ): Promise<string> {
    // Archived eight days back: a goal archived on its week's Sunday still governs that week (RP-24).
    const [row] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at, archived_at)
      values (${userId}, ${name}, ${horizon}::date, ${measure?.name ?? null}, ${measure?.unit ?? null},
              coalesce(${createdAt}::timestamptz, now() - interval '28 days'),
              ${archived ? new Date(Date.now() - 8 * 86_400_000).toISOString() : null}::timestamptz)
      returning id
    `;
    goalIds.push(row.id);
    return row.id;
  }
  async function seedCommitment(
    goalId: string,
    name: string,
    quantity: boolean,
    createdAt: string | null = null,
  ): Promise<string> {
    const [row] = await db<{ id: string }[]>`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${userId}, ${goalId}, ${name}, 'daily', ${quantity ? "quantity" : "tap"},
              ${quantity ? 10 : null}, ${quantity ? "min" : null},
              coalesce(${createdAt}::timestamptz, now() - interval '28 days'))
      returning id
    `;
    return row.id;
  }
  // `goal_id` rides on the fact the way `declareFact` copies it: `loadGoal`
  // reads a goal's facts by it.
  async function seedFact(
    goalId: string,
    commitmentId: string,
    day: string,
    quantity: number | null,
  ): Promise<void> {
    await db`
      insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
      values (${userId}, ${goalId}, ${commitmentId}, ${day}::date, ${quantity})
    `;
  }
  async function seedOneOff(name: string, goalId: string | null, day: string | null): Promise<string> {
    const [row] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, day)
      values (${userId}, ${goalId}, ${name}, ${day}::date)
      returning id
    `;
    oneOffIds.push(row.id);
    return row.id;
  }

  try {
    const ended = await seedGoal("check-74 ended", today, null);
    await seedCommitment(ended, "check-74 ended tap", false);
    const measured = await seedGoal("check-74 measured", "2099-12-31", { name: "minutos", unit: "min" });
    const measuredCommitment = await seedCommitment(measured, "check-74 minutes", true);
    const plain = await seedGoal("check-74 plain", "2099-12-31", null);
    await seedCommitment(plain, "check-74 plain tap", false);
    const archivedGoal = await seedGoal("check-74 archived", "2099-12-31", null, true);
    await seedCommitment(archivedGoal, "check-74 archived tap", false);

    // 5 today, 100 the week before: the week's measure is 5 on any weekday.
    // The Monday's own share is proved in the fixture week below.
    const expectedMeasure = 5;
    await seedFact(measured, measuredCommitment, today, 5);
    await seedFact(measured, measuredCommitment, addDays(monday, -7), 100);

    const doneOneOff = await seedOneOff("check-74 done today", null, today);
    await db`
      insert into goals.facts (user_id, one_off_id, goal_id, day)
      values (${userId}, ${doneOneOff}, null, ${today}::date)
    `;
    const [doneFact] = await db<{ written_at: Date }[]>`
      select written_at from goals.facts where one_off_id = ${doneOneOff}
    `;
    const tomorrowOneOff = await seedOneOff("check-74 tomorrow", null, tomorrow);
    const laterOneOff = await seedOneOff("check-74 in three days", null, addDays(today, 3));
    const todayOneOff = await seedOneOff("check-74 dated today", null, today);
    const endedScheduled = await seedOneOff("check-74 ended goal, scheduled", ended, tomorrow);
    const endedDayless = await seedOneOff("check-74 ended goal, dayless", ended, null);

    const dayStart = wireCalls.length;
    const todayDay = await loadDay(today);
    const dayApplication = applicationStatements(wireCalls.slice(dayStart));
    const yesterdayDay = await loadDay(yesterday);
    assert("loadDay still issues four application statements", dayApplication === 4, `${dayApplication}`);

    assert(
      "a goal whose horizon is today is absent from loadDay(today).goals",
      !todayDay.goals.some((goal) => goal.id === ended),
      `goals = ${JSON.stringify(todayDay.goals.map((goal) => goal.name))}`,
    );
    assert(
      "it is present in loadDay(yesterday).goals",
      yesterdayDay.goals.some((goal) => goal.id === ended),
      `goals = ${JSON.stringify(yesterdayDay.goals.map((goal) => goal.name))}`,
    );
    assert(
      "an archived goal is on no day",
      !todayDay.goals.some((goal) => goal.id === archivedGoal) &&
        !yesterdayDay.goals.some((goal) => goal.id === archivedGoal),
      "checked today and yesterday",
    );

    const doneRow = todayDay.doneOneOffs.find((row) => row.id === doneOneOff);
    assert(
      "a one-off completed today carries writtenAt equal to its fact's written_at",
      doneRow !== undefined && new Date(doneRow.writtenAt).getTime() === doneFact.written_at.getTime(),
      `writtenAt = ${doneRow?.writtenAt}, fact ${doneFact.written_at.toISOString()}`,
    );

    const openOneOffs = todayDay.oneOffs.map((row) => row.id);
    assert(
      "a one-off dated tomorrow is not in oneOffs",
      !openOneOffs.includes(tomorrowOneOff) && !openOneOffs.includes(laterOneOff),
      `ids = ${JSON.stringify(openOneOffs)}`,
    );
    assert("a one-off dated today is in oneOffs", openOneOffs.includes(todayOneOff), "checked");

    const [expected] = await db<{ n: number }[]>`
      select count(*)::int as n from goals.one_offs o
      where o.user_id = ${userId}
        and o.day > ${today}::date
        and not exists (select 1 from goals.facts f where f.one_off_id = o.id)
        and (o.goal_id is null or exists (
          select 1 from goals.goals g
          where g.id = o.goal_id and g.archived_at is null and g.horizon > ${today}::date))
    `;
    const countedNow = (await loadDay(today)).scheduledCount;
    assert(
      "scheduledCount counts tomorrow's and the later one, not today's nor an ended goal's",
      countedNow === expected.n && countedNow >= 2,
      `scheduledCount ${countedNow}, database read ${expected.n}`,
    );

    const listStart = wireCalls.length;
    const scheduled = await listScheduledOneOffs(today);
    const listApplication = applicationStatements(wireCalls.slice(listStart));
    const scheduledIds = scheduled.map((row) => row.id);
    assert("listScheduledOneOffs issues two application statements", listApplication === 2, `${listApplication}`);
    assert(
      "listScheduledOneOffs lists tomorrow's and the later one, in day order",
      scheduledIds.includes(tomorrowOneOff) &&
        scheduledIds.includes(laterOneOff) &&
        scheduledIds.indexOf(tomorrowOneOff) < scheduledIds.indexOf(laterOneOff),
      `ids = ${JSON.stringify(scheduledIds)}`,
    );
    assert(
      "it lists neither today's one-off, nor an ended goal's, nor a done one",
      !scheduledIds.includes(todayOneOff) &&
        !scheduledIds.includes(endedScheduled) &&
        !scheduledIds.includes(doneOneOff),
      `ids = ${JSON.stringify(scheduledIds)}`,
    );
    const dayless = (await listDaylessOneOffs()).map((row) => row.id);
    assert(
      "an ended goal's dayless one-off is not listed",
      !dayless.includes(endedDayless),
      `ids = ${JSON.stringify(dayless)}`,
    );

    assert(
      "weekMeasure holds the goal's measure since Monday",
      todayDay.weekMeasure[measured] === expectedMeasure,
      `weekMeasure = ${todayDay.weekMeasure[measured]}, seeded ${expectedMeasure}`,
    );
    const goalView = await loadGoal(measured);
    const currentWeek = goalView?.weeks.find((week) => week.current);
    assert(
      "it equals the current week of loadGoal(id).weeks",
      currentWeek !== undefined && currentWeek.total === todayDay.weekMeasure[measured],
      `loadGoal ${currentWeek?.total}, loadDay ${todayDay.weekMeasure[measured]}`,
    );
    assert(
      "a goal without a measure has no key",
      !(plain in todayDay.weekMeasure) && !(ended in todayDay.weekMeasure),
      `keys = ${JSON.stringify(Object.keys(todayDay.weekMeasure))}`,
    );

    const weekStart = wireCalls.length;
    const week = await loadWeek(today);
    const weekApplication = applicationStatements(wireCalls.slice(weekStart));
    assert("loadWeek still issues four application statements", weekApplication === 4, `${weekApplication}`);
    const weekOneOff = week.oneOffFacts.find((fact) => fact.oneOffId === doneOneOff);
    assert(
      "loadWeek's one-off facts carry the one-off's id and name",
      weekOneOff?.name === "check-74 done today",
      `fact = ${JSON.stringify(weekOneOff)}`,
    );
    assert(
      "an archived goal is not in loadWeek's goals",
      !week.goals.some((goal) => goal.id === archivedGoal),
      "checked",
    );

    // Every probe that reads the Monday or the week's days runs in a fixed
    // week (Mon 2012-03-12, probed on the Wednesday), never on today's weekday.
    const FIX_MONDAY = "2012-03-12";
    const FIX_DAY = "2012-03-14";
    const FIX_CREATED = "2012-01-02T12:00:00Z";

    const fxEnded = await seedGoal("check-74 fixture ended", FIX_DAY, null, false, FIX_CREATED);
    const fxEndedCommitment = await seedCommitment(fxEnded, "check-74 fixture ended tap", false, FIX_CREATED);
    const fxEndedOnMonday = await seedGoal("check-74 fixture ended on monday", FIX_MONDAY, null, false, FIX_CREATED);
    await seedCommitment(fxEndedOnMonday, "check-74 fixture ended on monday tap", false, FIX_CREATED);
    const fxMeasured = await seedGoal("check-74 fixture measured", "2012-12-31", { name: "minutos", unit: "min" }, false, FIX_CREATED);
    const fxMeasuredCommitment = await seedCommitment(fxMeasured, "check-74 fixture minutes", true, FIX_CREATED);
    await seedFact(fxMeasured, fxMeasuredCommitment, FIX_MONDAY, 7);
    await seedFact(fxMeasured, fxMeasuredCommitment, FIX_DAY, 5);
    await seedFact(fxMeasured, fxMeasuredCommitment, addDays(FIX_MONDAY, -7), 100);

    const fxDay = await loadDay(FIX_DAY);
    const fxCurrent = (await loadGoal(fxMeasured, FIX_DAY))?.weeks.find((row) => row.current);
    assert(
      "weekMeasure holds the goal's measure since the Monday: 7 on it, 5 on the day, none of last week's 100",
      fxDay.weekMeasure[fxMeasured] === 12,
      `weekMeasure = ${fxDay.weekMeasure[fxMeasured]}, seeded 12`,
    );
    assert(
      "it equals the current week of loadGoal(id, day).weeks",
      fxCurrent !== undefined && fxCurrent.total === fxDay.weekMeasure[fxMeasured],
      `loadGoal ${fxCurrent?.total}, loadDay ${fxDay.weekMeasure[fxMeasured]}`,
    );

    // A commitment retired earlier in the week still feeds the goal's week:
    // `weekMeasure` must equal the goal's own current row.
    const retiredGoal = await seedGoal("check-74 fixture retired", "2012-12-31", { name: "minutos", unit: "min" }, false, FIX_CREATED);
    const live = await seedCommitment(retiredGoal, "check-74 fixture retired goal, live", true, FIX_CREATED);
    const gone = await seedCommitment(retiredGoal, "check-74 fixture retired goal, gone", true, FIX_CREATED);
    await db`update goals.commitments set retired_at = '2012-03-13T12:00:00Z'::timestamptz where id = ${gone}`;
    await seedFact(retiredGoal, gone, FIX_MONDAY, 4);
    await seedFact(retiredGoal, live, FIX_DAY, 5);
    const retiredDay = await loadDay(FIX_DAY);
    const retiredCurrent = (await loadGoal(retiredGoal, FIX_DAY))?.weeks.find((row) => row.current);
    assert(
      "weekMeasure still counts a commitment retired earlier this week, as loadGoal does",
      retiredCurrent !== undefined &&
        retiredCurrent.total === 9 &&
        retiredDay.weekMeasure[retiredGoal] === retiredCurrent.total,
      `loadGoal ${retiredCurrent?.total}, loadDay ${retiredDay.weekMeasure[retiredGoal]}, seeded 9`,
    );

    const fxWeek = await loadWeek(FIX_DAY);
    assert(
      "a goal that ended on the Tuesday is in loadWeek's goals, one that ended on the Monday is not",
      fxWeek.goals.some((goal) => goal.id === fxEnded) && !fxWeek.goals.some((goal) => goal.id === fxEndedOnMonday),
      `ids in week: ${JSON.stringify(fxWeek.goals.map((goal) => goal.name))}`,
    );
    const without = { ...fxWeek, goals: fxWeek.goals.filter((goal) => goal.id !== fxEnded) };
    const delta = tallyDays(fxWeek).map((tally, i) => tally.total - tallyDays(without)[i].total);
    const expectedDelta = fxWeek.view.days.map((day) =>
      day.day < FIX_DAY && day.slots.some((slot) => slot.commitmentId === fxEndedCommitment) ? 1 : 0,
    );
    assert(
      "the ended goal's commitment counts in tallyDays on the Monday and the Tuesday and from its horizon on not at all",
      JSON.stringify(delta) === JSON.stringify([1, 1, 0, 0, 0, 0, 0]) &&
        JSON.stringify(expectedDelta) === JSON.stringify(delta),
      `delta = ${JSON.stringify(delta)}, expected [1,1,0,0,0,0,0], slots say ${JSON.stringify(expectedDelta)}`,
    );
  } finally {
    if (oneOffIds.length > 0) {
      await db`delete from goals.one_offs where id in ${db(oneOffIds)} and user_id = ${userId}`;
    }
    if (goalIds.length > 0) {
      await db`delete from goals.goals where id in ${db(goalIds)} and user_id = ${userId}`;
    }
    await db.end();
  }
}

// Desktop slice survivors. Every row lives in a fixed past week so no other
// goal of the person can outrank or join it, is seeded under this run's
// identity, and is deleted by id.
async function runDesktopSurvivorsCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { loadWeek } = await import("@/lib/queries/week");
  const { getPerson } = await import("@/lib/session");
  const { weekOf } = await import("@/lib/zone");

  const person = await getPerson();
  if (!person) throw new Error("runDesktopSurvivorsCheck: no verified session");
  const userId = person.id;

  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const goalIds: string[] = [];
  const deviceId = "00000000-0000-4000-8000-0000000000d5";

  async function seedGoal(name: string, horizon: string, opts: { archived?: boolean; unit?: string } = {}) {
    const [row] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at, archived_at)
      values (${userId}, ${name}, ${horizon}::date, ${opts.unit ?? null}, ${opts.unit ?? null},
              '2009-12-01T00:00:00Z'::timestamptz, ${opts.archived ? "2010-01-01T00:00:00Z" : null}::timestamptz)
      returning id
    `;
    goalIds.push(row.id);
    return row.id;
  }

  try {
    // 2010-06-07 is a Monday.
    const monday = "2010-06-07";
    assert("the fixture Monday is a Monday", weekOf("2010-06-09")[0] === monday, weekOf("2010-06-09")[0]);

    // Hoy's all-ended card names the goal that ended last, and never an
    // archived one, however late its horizon.
    await seedGoal("survivor first-ended", "2010-06-01");
    await seedGoal("survivor last-ended", "2010-06-05");
    await seedGoal("survivor archived-later", "2010-06-06", { archived: true });
    const ended = (await loadDay("2010-06-09")).lastEnded;
    assert(
      "lastEnded names the goal that ended last, not the first and not an archived one",
      ended?.name === "survivor last-ended",
      `lastEnded = ${JSON.stringify(ended)}`,
    );

    // A goal that ended on or before the week's Monday never draws in the week.
    const beforeWeek = await seedGoal("survivor ended before week", "2010-06-03");
    const onMonday = await seedGoal("survivor ends on monday", monday);
    const inWeek = await seedGoal("survivor ends in week", "2010-06-08");
    const week = await loadWeek("2010-06-09");
    const weekIds = week.goals.map((goal) => goal.id);
    assert(
      "loadWeek omits a goal whose horizon is before the week and one whose horizon is the Monday",
      !weekIds.includes(beforeWeek) && !weekIds.includes(onMonday),
      `ended-before present ${weekIds.includes(beforeWeek)}, ends-on-monday present ${weekIds.includes(onMonday)}`,
    );
    assert("loadWeek keeps a goal that ends inside the week", weekIds.includes(inWeek), `ids = ${JSON.stringify(weekIds)}`);

    // The weekly figure reads evidence from every earlier day of the week,
    // and none from the week before.
    const measured = await seedGoal("survivor measured", "2099-12-31", { unit: "searches" });
    const [source] = await db<{ id: string }[]>`select id from goals.evidence_sources where key = 'reading_lookups'`;
    await db`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, source_id, threshold, created_at)
      values (${userId}, ${measured}, 'survivor evidence', 'daily', 'evidence', ${source.id}, 1,
              '2009-12-01T00:00:00Z'::timestamptz)
    `;
    const lookupAt = ["2010-06-07T17:00:00Z", "2010-06-07T18:00:00Z", "2010-06-06T17:00:00Z"];
    for (const [i, at] of lookupAt.entries()) {
      await db`
        insert into reading.lookups
          (user_id, device_id, local_id, at, received_at, text, normalised, kind, outcome,
           dictionary_ready, record_schema)
        values (${userId}, ${deviceId}, ${i + 1}, ${at}::timestamptz, ${at}::timestamptz, 'x', 'x',
                'word', 'exact', true, 1)
      `;
    }
    const measure = (await loadDay("2010-06-09")).weekMeasure[measured];
    assert(
      "weekMeasure on Wednesday counts Monday's two searches and not the Sunday before",
      measure === 2,
      `weekMeasure = ${measure}, seeded 2 on Monday and 1 on the Sunday before`,
    );
  } finally {
    await db`delete from reading.lookups where user_id = ${userId} and device_id = ${deviceId}::uuid`;
    if (goalIds.length > 0) {
      await db`delete from goals.goals where id in ${db(goalIds)} and user_id = ${userId}`;
    }
    await db.end();
  }
}

// Semana counts a flexible cadence by its own period. The week
// 2010-05-31..06-06 crosses a month, so «al mes» reaches facts the week's own
// rows never read, and «por semana» must not read the week before.
async function runFlexiblePeriodCheck(): Promise<void> {
  const { loadWeek } = await import("@/lib/queries/week");
  const { getPerson } = await import("@/lib/session");

  const person = await getPerson();
  if (!person) throw new Error("runFlexiblePeriodCheck: no verified session");
  const userId = person.id;

  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  let goalId: string | null = null;

  async function seedCommitment(name: string, kind: string, count: number | null): Promise<string> {
    const [row] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, satisfaction, created_at)
      values (${userId}, ${goalId}, ${name}, ${kind}, ${count}, 'tap', '2009-12-01T00:00:00Z'::timestamptz)
      returning id
    `;
    return row.id;
  }
  async function seedFacts(commitmentId: string, days: string[]): Promise<void> {
    for (const day of days) {
      await db`
        insert into goals.facts (user_id, goal_id, commitment_id, day)
        values (${userId}, ${goalId}, ${commitmentId}, ${day}::date)
      `;
    }
  }

  try {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${userId}, 'check-91 flexible', '2099-12-31'::date, '2009-12-01T00:00:00Z'::timestamptz)
      returning id
    `;
    goalId = goal.id;
    const weekly = await seedCommitment("check-91 weekly", "times_per_week", 3);
    const monthly = await seedCommitment("check-91 monthly", "times_per_month", 4);
    const daily = await seedCommitment("check-91 daily", "daily", null);
    // Weekly: two inside the week, one the week before. Monthly: four in June
    // (two inside the week, two after it) and one in May inside the week, so
    // counting the month by the week would say 3 and the month says 4.
    await seedFacts(weekly, ["2010-05-31", "2010-06-02", "2010-05-25"]);
    await seedFacts(monthly, ["2010-06-01", "2010-06-02", "2010-06-15", "2010-06-20", "2010-05-31"]);

    const week = await loadWeek("2010-06-02");
    const byId = new Map(week.commitments.map((c) => [c.id, c]));
    assert(
      "a times-per-week commitment counts the days it was done in this week only",
      byId.get(weekly)?.periodDone === 2,
      `periodDone = ${byId.get(weekly)?.periodDone}, seeded 2 in the week and 1 the week before`,
    );
    assert(
      "a times-per-month commitment counts its month, past the week's own days and not the month before",
      byId.get(monthly)?.periodDone === 4,
      `periodDone = ${byId.get(monthly)?.periodDone}, seeded 4 in June (2 in the week) and 1 in May`,
    );

    // A week that begins inside the month: the fact before its Monday still
    // belongs to the month, the one after its Sunday too.
    const inside = await seedCommitment("check-91 monthly inside", "times_per_month", 5);
    await seedFacts(inside, ["2010-06-03", "2010-06-15", "2010-06-30", "2010-05-30"]);
    const later = await loadWeek("2010-06-16");
    const insideRow = later.commitments.find((c) => c.id === inside);
    assert(
      "a times-per-month commitment counts a fact of its month before the week begins, and one after it ends",
      insideRow?.periodDone === 3,
      `periodDone = ${insideRow?.periodDone}, seeded 06-03 (before the week 06-14..20), 06-15, 06-30 and 05-30 (May)`,
    );
    assert(
      "a daily commitment carries no period count",
      byId.get(daily)?.periodDone === null,
      `periodDone = ${byId.get(daily)?.periodDone}`,
    );
  } finally {
    if (goalId) await db`delete from goals.goals where id = ${goalId} and user_id = ${userId}`;
    await db.end();
  }
}

// `loadDay` returns every phase of a goal so Hoy can say «fase 2 de
// 3»; the phases the day derives from stay the ones in effect, and the
// statement count stays four.
async function runPhasePositionCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { createGoal, addPhase } = await import("@/app/actions/plan");

  const goal = await createGoal({ name: "check-day phase position probe", horizon: "2099-12-31" });
  if (!goal.ok) throw new Error(`runPhasePositionCheck: createGoal failed: ${goal.error}`);

  const migrationDb = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const spans: [string, string][] = [
      ["2099-01-01", "2099-01-31"],
      ["2099-02-01", "2099-02-28"],
      ["2099-03-01", "2099-03-31"],
    ];
    const ids: string[] = [];
    for (const [startsOn, endsOn] of spans) {
      const phase = await addPhase({ goalId: goal.goalId, aim: `check-day position ${startsOn}`, startsOn, endsOn });
      if (!phase.ok) throw new Error(`runPhasePositionCheck: addPhase failed: ${phase.error}`);
      ids.push(phase.phaseId);
    }

    const start = wireCalls.length;
    const day = await loadDay("2099-02-10");
    const statements = applicationStatements(wireCalls.slice(start));
    assert(
      "loadDay places the phase in effect as 2 of the goal's 3, by starts_on",
      JSON.stringify(day.phasePositions[ids[1]]) === JSON.stringify({ ordinal: 2, total: 3 }) &&
        JSON.stringify(day.phasePositions[ids[0]]) === JSON.stringify({ ordinal: 1, total: 3 }) &&
        JSON.stringify(day.phasePositions[ids[2]]) === JSON.stringify({ ordinal: 3, total: 3 }),
      `positions = ${JSON.stringify(ids.map((id) => day.phasePositions[id]))}`,
    );
    assert(
      "loadDay's phases keep only the goal's phase in effect on the day",
      day.phases.filter((phase) => phase.goalId === goal.goalId).map((phase) => phase.id).join() === ids[1],
      `phases = ${JSON.stringify(day.phases.filter((phase) => phase.goalId === goal.goalId).map((phase) => phase.id))}`,
    );
    assert(
      "loadDay with every phase selected still issues four application statements",
      statements === 4,
      `${statements} application statement(s)`,
    );
  } finally {
    await migrationDb`delete from goals.goals where id = ${goal.goalId}`;
    await migrationDb.end();
  }
}

/**
 * Hoy asks a flexible commitment by its own period. `loadDay`
 * once selected the week's facts only, so a monthly commitment met in an
 * earlier week was asked again, and a weekly one met on Monday and Tuesday
 * was asked on Thursday. Fixed days: 2010-09-03 (Friday), the week of
 * 2010-09-20, and its Thursday 2010-09-23.
 */
async function runFlexibleDayFeedCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { getPerson } = await import("@/lib/session");

  const person = await getPerson();
  if (!person) throw new Error("runFlexibleDayFeedCheck: no verified session");
  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  let goalId: string | null = null;

  try {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, 'check-day flexible feed probe', '2011-12-31'::date, '2009-12-01T00:00:00Z'::timestamptz)
      returning id
    `;
    goalId = goal.id;

    async function seed(name: string, kind: string, count: number, days: string[]): Promise<string> {
      const [row] = await db<{ id: string }[]>`
        insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, satisfaction, created_at)
        values (${person!.id}, ${goal.id}, ${name}, ${kind}, ${count}, 'tap', '2009-12-01T00:00:00Z'::timestamptz)
        returning id
      `;
      for (const day of days) {
        await db`
          insert into goals.facts (user_id, goal_id, commitment_id, day)
          values (${person!.id}, ${goal.id}, ${row.id}, ${day}::date)
        `;
      }
      return row.id;
    }

    const monthly = await seed("feed monthly", "times_per_month", 1, ["2010-09-03"]);
    const monthlyOpen = await seed("feed monthly open", "times_per_month", 2, ["2010-09-03"]);
    const weekly = await seed("feed weekly", "times_per_week", 2, ["2010-09-20", "2010-09-21"]);

    const later = await loadDay("2010-09-23");
    const asked = (id: string) => later.view.slots.some((slot) => slot.commitmentId === id);
    assert(
      "a monthly commitment met on the 3rd is not asked on the 23rd, three weeks on",
      !asked(monthly),
      `slots asked: ${JSON.stringify(later.view.slots.map((slot) => slot.commitmentId))}`,
    );
    assert(
      "a monthly commitment one short of its quota is still asked on the 23rd",
      asked(monthlyOpen),
      `slots asked: ${JSON.stringify(later.view.slots.map((slot) => slot.commitmentId))}`,
    );
    assert(
      "a weekly commitment met on Monday and Tuesday is not asked on Thursday",
      !asked(weekly),
      `slots asked: ${JSON.stringify(later.view.slots.map((slot) => slot.commitmentId))}`,
    );
    assert(
      "periodDone counts the month's and the week's days: 1, 1 and 2",
      later.periodDone[monthly] === 1 && later.periodDone[monthlyOpen] === 1 && later.periodDone[weekly] === 2,
      `periodDone = ${JSON.stringify(later.periodDone)}`,
    );

    const factDay = await loadDay("2010-09-03");
    assert(
      "the day of the fact still draws the monthly commitment, done, and counts it in periodDone",
      factDay.view.slots.some((slot) => slot.commitmentId === monthly && slot.satisfied) &&
        factDay.periodDone[monthly] === 1,
      `slots = ${JSON.stringify(factDay.view.slots.map((slot) => [slot.commitmentId, slot.satisfied]))}, periodDone = ${JSON.stringify(factDay.periodDone)}`,
    );
  } finally {
    if (goalId) await db`delete from goals.goals where id = ${goalId}`;
    await db.end();
  }
}

async function runMain(): Promise<void> {
  const cookies = loadCookies();
  await assertSessionUserExists(cookies);
  installStubs(cookies, false);

  if (process.argv.includes("--module-74")) {
    await runEndedGoalScheduledCheck();
    console.log(failed ? "REPORT  failed" : "REPORT  passed");
    process.exit(failed ? 1 : 0);
  }

  if (process.argv.includes("--replace-race")) {
    await runReplaceRaceCheck();
    console.log(failed ? "REPORT  failed" : "REPORT  passed");
    process.exit(failed ? 1 : 0);
  }

  const seed = await seedBaseline();
  try {
    await runMainChecks(seed);
  } finally {
    await seed.cleanup();
  }

  console.log("");
  console.log(failed ? "REPORT  failed" : "REPORT  passed");
  process.exit(failed ? 1 : 0);
}

type Baseline = { goalIds: string[]; commitmentIds: string[]; cleanup: () => Promise<void> };

// Three goals and seven commitments of every kind, written through the app's
// own doors: the cold and warm calls, and the statement counts they assert,
// run over a day whose size a statement per goal or per commitment would
// change, never over whatever the identity happened to hold.
async function seedBaseline(): Promise<Baseline> {
  const { createGoal, addCommitment } = await import("@/app/actions/plan");
  type Input = Parameters<typeof addCommitment>[0];

  const daily = { cadenceKind: "daily" } as const;
  const groups: ((goalId: string) => Input)[][] = [
    [
      (goalId) => ({ goalId, name: "check-day baseline tap a", ...daily, satisfaction: "tap" }),
      (goalId) => ({ goalId, name: "check-day baseline tap b", ...daily, satisfaction: "tap" }),
      (goalId) => ({ goalId, name: "check-day baseline quantity a", ...daily, satisfaction: "quantity", targetQuantity: 3, unit: "min" }),
    ],
    [
      (goalId) => ({ goalId, name: "check-day baseline tap c", ...daily, satisfaction: "tap" }),
      (goalId) => ({ goalId, name: "check-day baseline evidence", ...daily, satisfaction: "evidence", sourceKey: "reading_lookups", threshold: 1 }),
    ],
    [
      (goalId) => ({ goalId, name: "check-day baseline tap d", ...daily, satisfaction: "tap" }),
      (goalId) => ({ goalId, name: "check-day baseline quantity b", ...daily, satisfaction: "quantity", targetQuantity: 2, unit: "min" }),
    ],
  ];

  const goalIds: string[] = [];
  const commitmentIds: string[] = [];
  await Promise.all(
    groups.map(async (group, index) => {
      const goal = await createGoal({ name: `check-day baseline goal ${index}`, horizon: "2099-12-31" });
      if (!goal.ok) throw new Error(`seedBaseline: createGoal failed: ${goal.error}`);
      goalIds.push(goal.goalId);
      await Promise.all(
        group.map(async (build) => {
          const commitment = await addCommitment(build(goal.goalId));
          if (!commitment.ok) throw new Error(`seedBaseline: addCommitment failed: ${commitment.error}`);
          commitmentIds.push(commitment.commitmentId);
        }),
      );
    }),
  );

  const { getPerson } = await import("@/lib/session");
  const person = await getPerson();
  if (!person) throw new Error("seedBaseline: no verified session");

  return {
    goalIds,
    commitmentIds,
    cleanup: async () => {
      const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
      try {
        await db`delete from goals.goals where id in ${db([...goalIds, ...probeGoalIds])} and user_id = ${person.id}`;
      } finally {
        await db.end();
      }
    },
  };
}

async function runMainChecks(seed: Baseline): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { todayInZone } = await import("@/lib/zone");
  const today = todayInZone();

  // First call: whatever the pool's connections happen to be, cold after
  // this process's own startup. Bracket, type-fetch cap, statement count and
  // overlap are asserted like any other run: the barrier holds the first
  // transaction before any dial, so a cold dial cannot fake a chain.
  const coldStart = wireCalls.length;
  const { result: cold, overlap: coldOverlap } = await withOverlap(() => loadDay(today));
  reportRun("cold", wireCalls.slice(coldStart), false, coldOverlap);

  // Five consecutive warm calls, each bounded on its own: a fix that only
  // holds for the first one or two warm calls after the cold one is a fix a
  // later screen the same minute would still be paying for — independent
  // validation found exactly that hole with a mutation that only bit from
  // the fourth `withGoalsDb` call on. Five, not more: this is the number
  // that closed the hole, and chasing a larger one buys nothing new.
  const WARM_CALLS = 5;
  const warmResults: Awaited<ReturnType<typeof loadDay>>[] = [];
  for (let i = 1; i <= WARM_CALLS; i++) {
    const start = wireCalls.length;
    const { result, overlap } = await withOverlap(() => loadDay(today));
    reportRun(`warm-${i}`, wireCalls.slice(start), true, overlap);
    warmResults.push(result);
    assert(`the warm-${i} run reads the source`, result.evidence === "read", `evidence = ${result.evidence}`);
  }

  const coldSlotIds = cold.view.slots.map((slot) => slot.commitmentId).sort();
  const warmSlotIdLists = warmResults.map((result) => result.view.slots.map((slot) => slot.commitmentId).sort());
  const lastWarmSlotIds = warmSlotIdLists[warmSlotIdLists.length - 1] ?? [];
  // A comparison of two empty sets passes whatever `deriveDay` does, so the
  // floor is the seed this run wrote itself.
  const missingSeeded = seed.commitmentIds.filter((id) => !coldSlotIds.includes(id));
  assert(
    "the cold run carries a slot for every commitment this run seeded",
    missingSeeded.length === 0 && coldSlotIds.length >= seed.commitmentIds.length,
    `${coldSlotIds.length} slot(s), ${missingSeeded.length} of ${seed.commitmentIds.length} seeded missing`,
  );
  assert(
    "the cold and every warm run declare the same slots",
    coldSlotIds.length >= 1 &&
      warmSlotIdLists.every((ids) => ids.length >= 1 && JSON.stringify(ids) === JSON.stringify(coldSlotIds)),
    `cold ${coldSlotIds.length} slot(s); warm ${warmSlotIdLists.map((ids) => ids.length).join(", ")} slot(s)`,
  );

  const degraded = runDegradedChildProcess();

  console.log(`\ndegraded run — evidence = ${degraded.evidence}`);
  console.log(`  undegraded slots: [${lastWarmSlotIds.join(", ")}]`);
  console.log(`  degraded slots:   [${degraded.slotIds.join(", ")}]`);

  assert(
    "the degraded run reports the source unreadable",
    degraded.evidence === "unreadable",
    `evidence = ${degraded.evidence}`,
  );
  assert(
    "every declared slot is still present when the source cannot be read",
    lastWarmSlotIds.length >= seed.commitmentIds.length &&
      JSON.stringify(degraded.slotIds) === JSON.stringify(lastWarmSlotIds),
    `undegraded ${lastWarmSlotIds.length} slot(s), degraded ${degraded.slotIds.length} slot(s)`,
  );

  await runZoneCheck();
  await runCadenceZoneCheck();
  await runWeekCommitmentsZoneCheck();
  await runPhaseWeekBoundCheck();
  await runFactSatisfactionCheck();
  await runEvidenceRefusalCheck();
  await runFactUniqueCheck();
  await runReplaceRaceCheck();
  await runOneOffCarryCheck();
  await runFactWrittenOnCheck();
  await runPhaseDayBoundCheck();
  await runCreatedOnAndOneOffsCheck();
  await runDaylessCountAndOrderCheck();
  await runEndedGoalScheduledCheck();
  await runDesktopSurvivorsCheck();
  await runFlexiblePeriodCheck();
  await runEndedThisWeekCheck();
  await runPhasePositionCheck();
  await runFlexibleDayFeedCheck();
  await runSurvivorsOf92To94Check();
  await runMonthLineCheck();
  await runMonthTaskCheck();
  await runPastWeekCheck();
  await runPlanReadCheck();
  await runGoallessDaylessCheck();
  await runEvidenceInfoAndFirstGoalDayCheck();
  await runWeekAcrossMonthEvidenceCheck();
  await runSharedMonthLineCheck();
  await runAiZeroPartCheck();
  await runEndlessAndLooseCheck();
}

// RP-76: a share of the rhythm that rounds to 0 stays 0 for the AI; only the
// screen turns it into «sin monto». 20 a month opened on a month's last day
// plans floor(20 × 1 / 31) = 0.
async function runAiZeroPartCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { shapeDay } = await import("@/lib/mcp/shape");
  const { getPerson } = await import("@/lib/session");

  const person = await getPerson();
  if (!person) throw new Error("runAiZeroPartCheck: no verified session");
  const userId = person.id;
  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  let goal: string | null = null;
  try {
    const [row] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
      values (${userId}, 'ai-zero-part probe', '2099-12-31'::date, 'kilometers', 'kilometers', 20,
              '2010-10-31T15:00:00Z'::timestamptz)
      returning id
    `;
    goal = row.id;
    const loaded = await loadDay("2010-10-31");
    assert(
      "the month line keeps a share that rounds to 0 as 0, not null",
      loaded.monthLine[goal]?.planned === 0,
      `monthLine = ${JSON.stringify(loaded.monthLine[goal])}`,
    );
    assert(
      "the line says the 0 is not a budget the person typed",
      loaded.monthLine[goal]?.ownBudget === false,
      `monthLine = ${JSON.stringify(loaded.monthLine[goal])}`,
    );
    const shaped = shapeDay(loaded).goals.find((g) => g.id === goal);
    assert(
      "get_today reads planned 0 for that goal, not null",
      shaped?.thisMonth?.planned?.value === 0,
      `thisMonth = ${JSON.stringify(shaped?.thisMonth)}`,
    );
  } finally {
    if (goal) await db`delete from goals.goals where id = ${goal} and user_id = ${userId}`;
    await db.end();
  }
}

// Hoy's «terminó ayer» line: goals whose last day fell in the week of the
// viewed day, before it. Rows live in a fixed 2010 week (Mon 06-07).
async function runEndedThisWeekCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { getPerson } = await import("@/lib/session");

  const person = await getPerson();
  if (!person) throw new Error("runEndedThisWeekCheck: no verified session");
  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const ids: string[] = [];

  async function seedGoal(name: string, horizon: string, archived = false) {
    const [row] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at, archived_at)
      values (${person!.id}, ${name}, ${horizon}::date, '2009-12-01T00:00:00Z'::timestamptz,
              ${archived ? "2010-01-01T00:00:00Z" : null}::timestamptz)
      returning id
    `;
    ids.push(row.id);
    return row.id;
  }

  try {
    const previousWeek = await seedGoal("ended-week last day sunday before", "2010-06-07");
    const monday = await seedGoal("ended-week last day monday", "2010-06-08");
    const tuesday = await seedGoal("ended-week last day tuesday", "2010-06-09");
    await seedGoal("ended-week archived", "2010-06-09", true);
    await seedGoal("ended-week still open", "2010-06-11");
    const ended = (await loadDay("2010-06-10")).endedThisWeek;
    const seeded = ended.filter((goal) => goal.name.startsWith("ended-week"));
    assert(
      "endedThisWeek lists the goals whose last day fell this week, in plan order, with the last day",
      JSON.stringify(seeded) ===
        JSON.stringify([
          { id: monday, name: "ended-week last day monday", lastDay: "2010-06-07" },
          { id: tuesday, name: "ended-week last day tuesday", lastDay: "2010-06-08" },
        ]),
      `endedThisWeek = ${JSON.stringify(seeded)}; the previous week's goal ${previousWeek} must be absent`,
    );
    const sunday = (await loadDay("2010-06-13")).endedThisWeek.filter((goal) => goal.name.startsWith("ended-week"));
    assert(
      "endedThisWeek on the Sunday holds the whole week's endings, the goal open on Thursday included",
      sunday.length === 3 && sunday.some((goal) => goal.lastDay === "2010-06-10"),
      `endedThisWeek on Sunday = ${JSON.stringify(sunday)}`,
    );

    // A fixed week (Mon 2010-08-02): endings on Monday, Tuesday and Thursday
    // read from its Friday, in plan order, and none from before.
    const before = await seedGoal("fixed-week before", "2010-08-02");
    const fixedMon = await seedGoal("fixed-week mon", "2010-08-03");
    const fixedTue = await seedGoal("fixed-week tue", "2010-08-04");
    const fixedThu = await seedGoal("fixed-week thu", "2010-08-06");
    const fixed = (await loadDay("2010-08-06")).endedThisWeek.filter((goal) => goal.name.startsWith("fixed-week"));
    assert(
      "endedThisWeek from a Friday holds the Thursday, Tuesday and Monday endings in plan order, none from the week before",
      JSON.stringify(fixed.map((goal) => [goal.id, goal.lastDay])) ===
        JSON.stringify([[fixedMon, "2010-08-02"], [fixedTue, "2010-08-03"], [fixedThu, "2010-08-05"]]),
      `endedThisWeek = ${JSON.stringify(fixed)}; the previous week's goal ${before} must be absent`,
    );
  } finally {
    if (ids.length > 0) await db`delete from goals.goals where id in ${db(ids)}`;
    await db.end();
  }
}

// `loadDay` on fixed 2012 days: Mon 2012-03-12 opens the week, Sun 2012-02-26 lies in the month
// before it.
async function runSurvivorsOf92To94Check(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { getPerson } = await import("@/lib/session");

  const person = await getPerson();
  if (!person) throw new Error("runSurvivorsOf92To94Check: no verified session");
  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  let goalId: string | null = null;

  try {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${person.id}, 'check-day survivors probe', '2012-12-31'::date, 'minutos', 'min',
              '2011-12-01T00:00:00Z'::timestamptz)
      returning id
    `;
    goalId = goal.id;
    const [commitment] = await db<{ id: string }[]>`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goal.id}, 'check-day survivors quantity', 'daily', 'quantity', 10, 'min',
              '2011-12-01T00:00:00Z'::timestamptz)
      returning id
    `;
    for (const [day, quantity] of [["2012-02-26", 50], ["2012-03-11", 7], ["2012-03-12", 10], ["2012-03-13", 5]] as const) {
      await db`
        insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
        values (${person.id}, ${goal.id}, ${commitment.id}, ${day}::date, ${quantity})
      `;
    }
    const measure = (await loadDay("2012-03-14")).weekMeasure[goal.id];
    assert(
      "weekMeasure on a Wednesday adds Monday and Tuesday and nothing from the month or the Sunday before",
      measure === 15,
      `weekMeasure = ${measure}, seeded 10 + 5 this week, 7 the Sunday before and 50 the month before`,
    );

    const phaseIds: string[] = [];
    for (const [aim, startsOn, endsOn] of [
      ["check-day survivors uno", "2012-03-01", "2012-03-10"],
      ["check-day survivors dos", "2012-03-11", "2012-03-20"],
    ]) {
      const [phase] = await db<{ id: string }[]>`
        insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
        values (${person.id}, ${goal.id}, ${aim}, ${startsOn}::date, ${endsOn}::date)
        returning id
      `;
      phaseIds.push(phase.id);
    }
    const first = await loadDay("2012-03-11");
    assert(
      "a phase's first day is in effect: the view names it, loadDay lists it and reads «2 de 2»",
      first.view.phase?.id === phaseIds[1] &&
        first.phases.some((phase) => phase.id === phaseIds[1]) &&
        JSON.stringify(first.phasePositions[phaseIds[1]]) === JSON.stringify({ ordinal: 2, total: 2 }),
      `view.phase = ${JSON.stringify(first.view.phase)}, phases = ${JSON.stringify(first.phases.map((p) => p.id))}`,
    );
    const last = await loadDay("2012-03-10");
    assert(
      "a phase's last day is still in effect and the next one is not yet",
      last.view.phase?.id === phaseIds[0] && !last.phases.some((phase) => phase.id === phaseIds[1]),
      `view.phase = ${JSON.stringify(last.view.phase)}`,
    );
    const after = await loadDay("2012-03-21");
    assert(
      "a day after every phase has no phase in effect",
      after.view.phase === null && !after.phases.some((phase) => phaseIds.includes(phase.id)),
      `view.phase = ${JSON.stringify(after.view.phase)}`,
    );
  } finally {
    if (goalId) await db`delete from goals.goals where id = ${goalId}`;
    await db.end();
  }
}

// Hoy's month line (RP-28, RP-29), the month task leaving the
// dayless list (RP-31) and a done estimate staying out of the measure (RP-128).
// Fixed October 2010: Wed 2010-10-20 is the pace day, Tue 10-19 is not.
async function runMonthLineCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { listDaylessOneOffs } = await import("@/lib/queries/one-offs");
  const { getPerson } = await import("@/lib/session");

  const person = await getPerson();
  if (!person) throw new Error("runMonthLineCheck: no verified session");
  const userId = person.id;
  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const goalIds: string[] = [];
  const plainIds: string[] = [];
  const deviceId = "00000000-0000-4000-8000-0000000000e8";

  async function seedGoal(name: string): Promise<string> {
    const [row] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${userId}, ${name}, '2099-12-31'::date, 'searches', 'searches',
              '2010-09-01T00:00:00Z'::timestamptz)
      returning id
    `;
    goalIds.push(row.id);
    return row.id;
  }

  try {
    // 720 planned; 400 + 26 declared and 5 searched on 10-02 reach 431.
    const goal = await seedGoal("month-line probe");
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${userId}, ${goal}, '2010-10-01'::date, 720)
    `;
    const [commitment] = await db<{ id: string }[]>`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${userId}, ${goal}, 'month-line quantity', 'daily', 'quantity', 10, 'searches',
              '2010-09-01T00:00:00Z'::timestamptz)
      returning id
    `;
    for (const [day, quantity] of [["2010-10-05", 400], ["2010-10-06", 26]] as const) {
      await db`
        insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
        values (${userId}, ${goal}, ${commitment.id}, ${day}::date, ${quantity})
      `;
    }
    const [source] = await db<{ id: string }[]>`select id from goals.evidence_sources where key = 'reading_lookups'`;
    await db`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, source_id, threshold, created_at)
      values (${userId}, ${goal}, 'month-line evidence', 'daily', 'evidence', ${source.id}, 1,
              '2009-12-01T00:00:00Z'::timestamptz)
    `;
    for (let i = 1; i <= 5; i++) {
      await db`
        insert into reading.lookups
          (user_id, device_id, local_id, at, received_at, text, normalised, kind, outcome,
           dictionary_ready, record_schema)
        values (${userId}, ${deviceId}::uuid, ${i}, '2010-10-02T17:00:00Z'::timestamptz,
                '2010-10-02T17:00:00Z'::timestamptz, 'x', 'x', 'word', 'exact', true, 1)
      `;
    }

    const pace = await loadDay("2010-10-20");
    const line = pace.monthLine[goal];
    assert(
      "720 planned and 431 reached on the 20th reads under pace, the 10-02 evidence counted in the month",
      line?.planned === 720 && line.reached === 431 && line.underPace === true,
      `monthLine = ${JSON.stringify(line)}`,
    );
    assert(
      "the 10-02 evidence counts toward the month and not toward the week",
      pace.weekMeasure[goal] === 0,
      `weekMeasure = ${pace.weekMeasure[goal]}`,
    );
    const eve = (await loadDay("2010-10-19")).monthLine[goal];
    assert(
      "the same 431 of 720 on the 19th does not read under pace",
      eve?.reached === 431 && eve.underPace === false,
      `monthLine = ${JSON.stringify(eve)}`,
    );

    // Estimates: a done leaf adds nothing, nor does its undone sibling (RP-128).
    const estimated = await seedGoal("month-line estimate probe");
    // A goal measured in time still counts hours from blocks alone (RP-128).
    await db`update goals.goals set measure_name = 'minutos', measure_unit = 'minutos' where id = ${estimated}`;
    const [slotCommitment] = await db<{ id: string }[]>`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${userId}, ${estimated}, 'month-line estimate slot', 'daily', 'quantity', 10, 'searches',
              '2010-09-01T00:00:00Z'::timestamptz)
      returning id
    `;
    const slotOf = (day: Awaited<ReturnType<typeof loadDay>>) =>
      JSON.stringify(day.view.slots.find((slot) => slot.commitmentId === slotCommitment.id));
    const slotBefore = slotOf(await loadDay("2010-10-20"));
    const [done] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
      values (${userId}, ${estimated}, 'month-line done task', '2010-10-01'::date, 60)
      returning id
    `;
    await db`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
      values (${userId}, ${estimated}, 'month-line undone sibling', '2010-10-01'::date, 40)
    `;
    await db`
      insert into goals.facts (user_id, goal_id, one_off_id, day)
      values (${userId}, ${estimated}, ${done.id}, '2010-10-20'::date)
    `;
    const withEstimate = await loadDay("2010-10-20");
    assert(
      "a done task estimated at 60 adds nothing to weekMeasure nor to the month's reached (RP-128)",
      withEstimate.weekMeasure[estimated] === 0 && withEstimate.monthLine[estimated]?.reached === 0,
      `weekMeasure = ${withEstimate.weekMeasure[estimated]}, monthLine = ${JSON.stringify(withEstimate.monthLine[estimated])}`,
    );
    assert(
      "a commitment's slot is unchanged by the estimate",
      slotOf(withEstimate) === slotBefore,
      `before ${slotBefore}, after ${slotOf(withEstimate)}`,
    );

    // The month task and its sub-task leave /sueltas; a plain one stays.
    const [parent] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month)
      values (${userId}, ${estimated}, 'month-line parent', '2010-10-01'::date)
      returning id
    `;
    await db`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, parent_id)
      values (${userId}, ${estimated}, 'month-line child', null, ${parent.id})
    `;
    const [plain] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name) values (${userId}, null, 'month-line plain dayless')
      returning id
    `;
    plainIds.push(plain.id);
    const baseline = (await loadDay("2010-10-20")).daylessCount;
    const listed = (await listDaylessOneOffs()).filter((o) => o.name.startsWith("month-line"));
    assert(
      "a month-planned one-off and its sub-task are absent from the dayless list, a plain one is present",
      listed.length === 1 && listed[0].name === "month-line plain dayless",
      `listed = ${JSON.stringify(listed.map((o) => o.name))}`,
    );
    const [{ n }] = await db<{ n: number }[]>`
      select count(*)::int as n from goals.one_offs o
        where o.user_id = ${userId} and o.day is null and o.planned_month is null and o.parent_id is null
          and not exists (select 1 from goals.facts f where f.one_off_id = o.id)
          and o.goal_id is null
    `;
    assert(
      "daylessCount excludes the month task and its sub-task and counts the plain one",
      baseline === n,
      `daylessCount = ${baseline}, expected ${n}`,
    );

    // The overlap and the four statements, on the day with a budget.
    await loadDay("2010-10-20");
    const start = wireCalls.length;
    const { overlap } = await withOverlap(() => loadDay("2010-10-20"));
    reportRun("month-line", wireCalls.slice(start), true, overlap);
  } finally {
    await db`delete from reading.lookups where user_id = ${userId} and device_id = ${deviceId}::uuid`;
    if (plainIds.length > 0) {
      await db`delete from goals.one_offs where id in ${db(plainIds)} and user_id = ${userId}`;
    }
    if (goalIds.length > 0) {
      await db`delete from goals.goals where id in ${db(goalIds)} and user_id = ${userId}`;
    }
    await db.end();
  }
}

// Each open goal's next undone leaf of the month, read inside the
// goals statement (RP-31, RNP-03). Seeded on today's own month, since only
// today reads it; creation stamps are fixed so only the order decides.
async function runMonthTaskCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { getPerson } = await import("@/lib/session");
  const { todayInZone } = await import("@/lib/zone");
  const { monthOf, nextMonth } = await import("@/lib/plan/months");

  const person = await getPerson();
  if (!person) throw new Error("runMonthTaskCheck: no verified session");
  const userId = person.id;
  const today = todayInZone();
  const month = monthOf(today);
  const previous = monthOf(addDays(month, -1));
  const following = nextMonth(month);
  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  let goalId = "";

  async function seed(
    name: string,
    plannedMonth: string | null,
    parentId: string | null,
    day: string | null,
    createdAt: string,
    estimate: number | null = null,
    note: string | null = null,
  ): Promise<string> {
    const [row] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, parent_id, day, estimate, note, created_at)
      values (${userId}, ${goalId}, ${name}, ${plannedMonth}::date, ${parentId}, ${day}::date, ${estimate}, ${note},
              ${createdAt}::timestamptz)
      returning id
    `;
    return row.id;
  }
  async function finish(oneOffId: string): Promise<void> {
    await db`
      insert into goals.facts (user_id, goal_id, one_off_id, day) values (${userId}, ${goalId}, ${oneOffId}, ${today}::date)
    `;
  }

  try {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${userId}, 'month-task probe', '2099-12-31'::date, '2020-01-01T00:00:00Z'::timestamptz)
      returning id
    `;
    goalId = goal.id;

    await seed("month-task dated", month, null, today, "2020-01-01T00:00:00Z");
    await seed("month-task next month", following, null, null, "2020-01-02T00:00:00Z");
    const own = await seed("month-task own", month, null, null, "2020-01-03T00:00:00Z", 90);
    const parent = await seed("month-task carried parent", previous, null, null, "2020-01-04T00:00:00Z");
    const first = await seed("month-task child 1", null, parent, null, "2020-01-05T00:00:00Z", 30);
    const second = await seed("month-task child 2", null, parent, null, "2020-01-06T00:00:00Z", 45, "month-task note");
    const third = await seed("month-task child 3", null, parent, null, "2020-01-07T00:00:00Z", 15);
    await finish(first);

    const nextOf = async () => (await loadDay(today)).monthTask[goal.id];
    const carried = await nextOf();
    assert(
      "the carried parent's undone child is the goal's next task, before the month's own and any dated one-off",
      carried?.id === second &&
        carried.name === "month-task child 2" &&
        carried.estimate === 45 &&
        carried.note === "month-task note" &&
        carried.parentName === "month-task carried parent",
      `monthTask = ${JSON.stringify(carried)}`,
    );

    await finish(second);
    const afterSecond = await nextOf();
    assert(
      "the next undone child follows in plan order, a parent's name riding with it and no note of its own",
      afterSecond?.id === third && afterSecond.note === null && afterSecond.parentName === "month-task carried parent",
      `monthTask = ${JSON.stringify(afterSecond)}`,
    );

    await finish(third);
    const ownNext = await nextOf();
    assert(
      "with the carried child done the month's own task is next, and a task of the month after never is",
      ownNext?.id === own && ownNext.estimate === 90 && ownNext.parentName === null,
      `monthTask = ${JSON.stringify(ownNext)}`,
    );

    await finish(own);
    const none = await loadDay(today);
    assert(
      "with every task of the month done the goal reads null, a dated one-off and a later month never next",
      goal.id in none.monthTask && none.monthTask[goal.id] === null,
      `monthTask = ${JSON.stringify(none.monthTask[goal.id])}`,
    );

    const past = await loadDay(addDays(today, -1));
    assert("a past day reads an empty monthTask", Object.keys(past.monthTask).length === 0, JSON.stringify(past.monthTask));

    await loadDay(today);
    const start = wireCalls.length;
    const { overlap } = await withOverlap(() => loadDay(today));
    reportRun("month-task", wireCalls.slice(start), true, overlap);
  } finally {
    if (goalId) await db`delete from goals.goals where id = ${goalId} and user_id = ${userId}`;
    await db.end();
  }
}

// RP-44, RP-24: a past week keeps the goals that governed it, an
// archive since included, and drops one opened after it; `firstMonday` is the
// oldest goal's Monday, archived included, read in the same statement. Rows
// are relative to today and deleted by id.
async function runPastWeekCheck(): Promise<void> {
  const { loadWeek } = await import("@/lib/queries/week");
  const { getPerson } = await import("@/lib/session");
  const { todayInZone, weekOf } = await import("@/lib/zone");

  const person = await getPerson();
  if (!person) throw new Error("runPastWeekCheck: no verified session");
  const today = todayInZone();
  const threeBack = addDays(today, -21);
  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const ids: string[] = [];

  async function seedGoal(name: string, createdDay: string, archivedDay: string | null): Promise<string> {
    const [row] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at, archived_at)
      values (${person!.id}, ${name}, '2099-12-31'::date, ${`${createdDay}T17:00:00Z`}::timestamptz,
              ${archivedDay ? `${archivedDay}T17:00:00Z` : null}::timestamptz)
      returning id
    `;
    ids.push(row.id);
    return row.id;
  }

  try {
    const oldest = await seedGoal("past-week oldest archived", "2001-01-03", "2001-02-03");
    const governed = await seedGoal("past-week governed", addDays(today, -35), addDays(today, -14));
    const later = await seedGoal("past-week opened last week", addDays(today, -7), null);

    await loadWeek(threeBack);
    const start = wireCalls.length;
    const { result: past, overlap } = await withOverlap(() => loadWeek(threeBack));
    reportRun("past-week", wireCalls.slice(start), true, overlap);
    const current = await loadWeek(today);

    assert(
      "a goal opened five weeks ago and archived two weeks ago is in the week three back",
      past.goals.some((goal) => goal.id === governed),
      `goals = ${JSON.stringify(past.goals.map((goal) => goal.name))}`,
    );
    assert(
      "it is not in this week",
      !current.goals.some((goal) => goal.id === governed),
      `goals = ${JSON.stringify(current.goals.map((goal) => goal.name))}`,
    );
    assert(
      "a goal opened last week is absent from the week three back",
      !past.goals.some((goal) => goal.id === later),
      `goals = ${JSON.stringify(past.goals.map((goal) => goal.name))}`,
    );
    assert(
      "it is in this week",
      current.goals.some((goal) => goal.id === later),
      `goals = ${JSON.stringify(current.goals.map((goal) => goal.name))}`,
    );
    assert(
      "a goal archived long before the week is not in it",
      !past.goals.some((goal) => goal.id === oldest),
      `goals = ${JSON.stringify(past.goals.map((goal) => goal.name))}`,
    );
    assert(
      "firstMonday is the Monday of the oldest goal, archived included",
      past.firstMonday === weekOf("2001-01-03")[0] && current.firstMonday === past.firstMonday,
      `past ${past.firstMonday}, this ${current.firstMonday}, expected ${weekOf("2001-01-03")[0]}`,
    );
  } finally {
    if (ids.length > 0) {
      await db`delete from goals.goals where id in ${db(ids)} and user_id = ${person.id}`;
    }
    await db.end();
  }
}

// RP-50, RP-52, RP-53, RNP-03: Hoy reads the plan. A 30-hour task
// at a rhythm of 10 is split across three months and gives its first part;
// last month closed with 5 done of its 10, so the end moved and the notice
// says so, once, today alone, until `plan_seen` reaches the closed month.
async function runPlanReadCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { getPerson } = await import("@/lib/session");
  const { todayInZone } = await import("@/lib/zone");
  const { monthOf } = await import("@/lib/plan/months");

  const person = await getPerson();
  if (!person) throw new Error("runPlanReadCheck: no verified session");
  const userId = person.id;
  const today = todayInZone();
  const closed = monthOf(addDays(monthOf(today), -1));
  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const goalIds: string[] = [];

  async function seedGoal(name: string, rhythm: number | null): Promise<string> {
    const [row] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
      values (${userId}, ${name}, '2099-12-31'::date, 'hours', 'hours', ${rhythm},
              '2020-01-01T00:00:00Z'::timestamptz)
      returning id
    `;
    goalIds.push(row.id);
    return row.id;
  }
  async function seedTask(goal: string, name: string, estimate: number, createdAt: string): Promise<string> {
    const [row] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, estimate, in_plan, created_at)
      values (${userId}, ${goal}, ${name}, ${estimate}, true, ${createdAt}::timestamptz)
      returning id
    `;
    return row.id;
  }

  try {
    const goal = await seedGoal("plan-read probe", 10);
    const small = await seedTask(goal, "plan-read done in the closed month", 5, "2020-01-01T00:00:00Z");
    const big = await seedTask(goal, "plan-read split", 30, "2020-01-02T00:00:00Z");
    await db`
      insert into goals.facts (user_id, goal_id, one_off_id, day) values (${userId}, ${goal}, ${small}, ${closed}::date)
    `;
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount) values (${userId}, ${goal}, ${closed}::date, 12)
    `;
    const loose = await seedGoal("plan-read no rhythm", null);

    const loaded = await loadDay(today);
    const next = loaded.monthTask[goal];
    assert(
      "a split task is the next task and gives this month's part, not its whole estimate",
      next?.id === big && next.part === 10 && next.estimate === 30,
      `monthTask = ${JSON.stringify(next)}`,
    );
    const counts = loaded.monthTaskCounts[goal];
    assert(
      "the month's counts come from the plan: the split task, none done",
      counts?.done === 0 && counts.total === 1,
      `monthTaskCounts = ${JSON.stringify(counts)}`,
    );
    assert("the month line plans the rhythm", loaded.monthLine[goal]?.planned === 10, JSON.stringify(loaded.monthLine[goal]));

    const notice = loaded.planNotice[goal];
    assert(
      "a month that closed short reads a notice with the closed month, what was done and the amount its own budget set",
      notice !== null &&
        notice.closedMonth === closed &&
        notice.closedDone === 5 &&
        notice.closedAmount === 12 &&
        notice.movedDays > 0,
      `planNotice = ${JSON.stringify(notice)}`,
    );
    assert(
      "a goal with no rhythm reads no notice",
      loaded.planNotice[loose] === null,
      `planNotice = ${JSON.stringify(loaded.planNotice[loose])}`,
    );
    const past = await loadDay(addDays(today, -1));
    assert("a past day reads no notice", Object.keys(past.planNotice).length === 0, JSON.stringify(past.planNotice));

    await db`update goals.goals set plan_seen = ${closed}::date where id = ${goal}`;
    const seen = await loadDay(today);
    assert("once plan_seen reaches the closed month the notice is gone", seen.planNotice[goal] === null, JSON.stringify(seen.planNotice[goal]));

    await loadDay(today);
    const start = wireCalls.length;
    const { overlap } = await withOverlap(() => loadDay(today));
    reportRun("plan-read", wireCalls.slice(start), true, overlap);
  } finally {
    if (goalIds.length > 0) {
      await db`delete from goals.goals where id in ${db(goalIds)} and user_id = ${userId}`;
    }
    await db.end();
  }
}

// RP-59: `/sueltas` and «N sin día» hold one-offs with no goal.
// A goal's task with no day is a task of its plan (0014), so it is in neither
// the list nor the count; a goal's task with a later day stays in
// `listScheduledOneOffs`. Counts are deltas on a baseline read first.
async function runGoallessDaylessCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { listDaylessOneOffs, listScheduledOneOffs } = await import("@/lib/queries/one-offs");
  const { createGoal } = await import("@/app/actions/plan");
  const { createOneOff } = await import("@/app/actions/one-offs");
  const { getPerson } = await import("@/lib/session");
  const { todayInZone } = await import("@/lib/zone");

  const person = await getPerson();
  if (!person) throw new Error("runGoallessDaylessCheck: no verified session");
  const today = todayInZone();
  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const goalIds: string[] = [];
  const oneOffIds: string[] = [];
  const baseline = await loadDay(today);
  const baselineScheduled = baseline.scheduledCount;

  try {
    const goal = await createGoal({ name: "check-day 407 probe", horizon: "2099-12-31" });
    if (!goal.ok) throw new Error(`runGoallessDaylessCheck: createGoal failed: ${goal.error}`);
    goalIds.push(goal.goalId);

    const task = await createOneOff({ name: "check-day 407 goal task", day: null, goalId: goal.goalId });
    if (!task.ok) throw new Error(`runGoallessDaylessCheck: createOneOff (goal task) failed: ${task.error}`);
    oneOffIds.push(task.oneOffId);

    const afterTask = await loadDay(today);
    assert(
      "a goal's dayless task does not move daylessCount",
      afterTask.daylessCount === baseline.daylessCount,
      `baseline ${baseline.daylessCount}, now ${afterTask.daylessCount}`,
    );

    const loose = await createOneOff({ name: "check-day 407 loose", day: null });
    if (!loose.ok) throw new Error(`runGoallessDaylessCheck: createOneOff (loose) failed: ${loose.error}`);
    oneOffIds.push(loose.oneOffId);

    const afterLoose = await loadDay(today);
    assert(
      "a goalless dayless one-off moves daylessCount by one",
      afterLoose.daylessCount === baseline.daylessCount + 1,
      `baseline ${baseline.daylessCount}, now ${afterLoose.daylessCount}`,
    );

    const listed = await listDaylessOneOffs();
    const ids = listed.map((row) => row.id);
    assert(
      "listDaylessOneOffs lists the goalless one-off and not the goal's task",
      ids.includes(loose.oneOffId) && !ids.includes(task.oneOffId),
      `ids = ${JSON.stringify(ids)}`,
    );
    assert(
      "every listed dayless one-off reads no goal",
      listed.every((row) => row.goalId === null && row.goalName === null),
      JSON.stringify(listed.filter((row) => row.goalId !== null)),
    );
    assert(
      "listDaylessOneOffs and daylessCount agree with a goal's task and a goalless one seeded",
      listed.length === afterLoose.daylessCount,
      `${listed.length} listed, ${afterLoose.daylessCount} counted`,
    );
    const [planRow] = await db<{ in_plan: boolean; day: string | null }[]>`
      select in_plan, day::text as day from goals.one_offs where id = ${task.oneOffId}
    `;
    assert(
      "the goal's task is in its plan with no day",
      planRow.in_plan === true && planRow.day === null,
      JSON.stringify(planRow),
    );

    const later = addDays(today, 2);
    const dated = await createOneOff({ name: "check-day 407 goal task later", day: later, goalId: goal.goalId });
    if (!dated.ok) throw new Error(`runGoallessDaylessCheck: createOneOff (dated) failed: ${dated.error}`);
    oneOffIds.push(dated.oneOffId);
    const scheduled = await listScheduledOneOffs(today);
    const row = scheduled.find((item) => item.id === dated.oneOffId);
    assert(
      "a goal's task with a later day stays in listScheduledOneOffs with its goal",
      row !== undefined && row.day === later && row.goalId === goal.goalId,
      `row = ${JSON.stringify(row)}`,
    );
    assert(
      "and counts in scheduledCount",
      (await loadDay(today)).scheduledCount === baselineScheduled + 1,
      `baseline ${baselineScheduled}`,
    );
  } finally {
    if (oneOffIds.length > 0) {
      await db`delete from goals.one_offs where id in ${db(oneOffIds)} and user_id = ${person.id}`;
    }
    if (goalIds.length > 0) {
      await db`delete from goals.goals where id in ${db(goalIds)} and user_id = ${person.id}`;
    }
    await db.end();
  }
}

/**
 * `loadDay` hands each evidence commitment its threshold and the catalogue
 * keys of its source, null for every other kind, and the civil day of the
 * person's oldest goal, archived included.
 */
async function runEvidenceInfoAndFirstGoalDayCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { getPerson } = await import("@/lib/session");
  const { todayInZone } = await import("@/lib/zone");

  const person = await getPerson();
  if (!person) throw new Error("runEvidenceInfoAndFirstGoalDayCheck: no verified session");
  const userId = person.id;
  const today = todayInZone();
  console.log(`\nmodule 571 check — ${new Date().toISOString()} (today ${today})`);

  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const goalIds: string[] = [];
  try {
    const [foreign] = await db<{ n: number; oldest: string | null }[]>`
      select count(*)::int as n, min(created_at at time zone 'America/Bogota')::date::text as oldest
      from goals.goals where user_id = ${userId}
    `;
    if (foreign.n === 0) {
      assert("a person with no goals has firstGoalDay null", (await loadDay(today)).firstGoalDay === null, "goals exist");
    } else {
      console.log(`NOTE    ${foreign.n} goal(s) not seeded here (oldest ${foreign.oldest}); the null case is not driven`);
    }

    const seedGoal = async (name: string, createdAt: string, archived: boolean): Promise<string> => {
      const [row] = await db<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, created_at, archived_at)
        values (${userId}, ${name}, '2099-12-31'::date, ${createdAt}::timestamptz,
                ${archived ? "2001-04-01T12:00:00Z" : null}::timestamptz)
        returning id
      `;
      goalIds.push(row.id);
      return row.id;
    };
    const archivedFirst = await seedGoal("check-571 archived third", "2001-03-03T15:00:00Z", true);
    await seedGoal("check-571 tenth", "2001-03-10T15:00:00Z", false);

    const [source] = await db<{ id: string }[]>`select id from goals.evidence_sources where key = 'reading_lookups'`;
    await db`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, source_id, threshold, created_at)
      values (${userId}, ${archivedFirst}, 'check-571 evidence', 'daily', 'evidence', ${source.id}, 3, '2001-03-03T15:00:00Z'::timestamptz)
    `;
    const openGoal = goalIds[1];
    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
      values (${userId}, ${openGoal}, 'check-571 tap', 'daily', 'tap', '2001-03-10T15:00:00Z'::timestamptz)
    `;
    await db`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${userId}, ${openGoal}, 'check-571 quantity', 'daily', 'quantity', 10, 'min', '2001-03-10T15:00:00Z'::timestamptz)
    `;

    const loaded = await loadDay(today);
    const mine = (name: string) => loaded.commitments.find((c) => c.name === name);
    assert(
      "an evidence commitment carries its threshold, its source's unit and its label and unit keys",
      JSON.stringify(mine("check-571 evidence")?.evidence) ===
        JSON.stringify({ threshold: 3, unit: "searches", labelKey: "sources.readingLookups", unitKey: "sources.readingLookupsUnit" }),
      `evidence = ${JSON.stringify(mine("check-571 evidence")?.evidence)}`,
    );
    assert(
      "a tap and a quantity commitment carry evidence null",
      mine("check-571 tap")?.evidence === null && mine("check-571 quantity")?.evidence === null,
      `tap ${JSON.stringify(mine("check-571 tap")?.evidence)}, quantity ${JSON.stringify(mine("check-571 quantity")?.evidence)}`,
    );
    const expectedFirst = foreign.n === 0 || (foreign.oldest !== null && foreign.oldest > "2001-03-03") ? "2001-03-03" : foreign.oldest;
    assert(
      "firstGoalDay is the oldest goal's civil day, archived included",
      loaded.firstGoalDay === expectedFirst,
      `firstGoalDay = ${loaded.firstGoalDay}, expected ${expectedFirst}`,
    );
  } finally {
    if (goalIds.length > 0) {
      await db`delete from goals.commitments where goal_id in ${db(goalIds)} and user_id = ${userId}`;
      await db`delete from goals.goals where id in ${db(goalIds)} and user_id = ${userId}`;
    }
    await db.end();
  }
}

/**
 * A week that crosses a month still counts the evidence of its days in the
 * month before: 2010-05-31 is the Monday of the week of Thursday 2010-06-03.
 */
async function runWeekAcrossMonthEvidenceCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { getPerson } = await import("@/lib/session");

  const person = await getPerson();
  if (!person) throw new Error("runWeekAcrossMonthEvidenceCheck: no verified session");
  const userId = person.id;
  console.log(`\nmodule 593 check — ${new Date().toISOString()}`);

  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const deviceId = "00000000-0000-4000-8000-0000000000d6";
  let goalId: string | null = null;
  try {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${userId}, 'check-593 measured', '2099-12-31'::date, 'searches', 'searches',
              '2009-12-01T00:00:00Z'::timestamptz)
      returning id
    `;
    goalId = goal.id;
    const [source] = await db<{ id: string }[]>`select id from goals.evidence_sources where key = 'reading_lookups'`;
    await db`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, source_id, threshold, created_at)
      values (${userId}, ${goalId}, 'check-593 evidence', 'daily', 'evidence', ${source.id}, 1,
              '2009-12-01T00:00:00Z'::timestamptz)
    `;
    // Monday 05-31 (the previous month), Tuesday 06-01, and the Sunday before the week.
    const lookupAt = ["2010-05-31T17:00:00Z", "2010-06-01T17:00:00Z", "2010-05-30T17:00:00Z"];
    for (const [i, at] of lookupAt.entries()) {
      await db`
        insert into reading.lookups
          (user_id, device_id, local_id, at, received_at, text, normalised, kind, outcome,
           dictionary_ready, record_schema)
        values (${userId}, ${deviceId}::uuid, ${i + 1}, ${at}::timestamptz, ${at}::timestamptz, 'x', 'x',
                'word', 'exact', true, 1)
      `;
    }
    const measure = (await loadDay("2010-06-03")).weekMeasure[goalId];
    assert(
      "weekMeasure on a Thursday of a week crossing a month counts the Monday of the month before",
      measure === 2,
      `weekMeasure = ${measure}, seeded 05-31 and 06-01 in the week and 05-30 the Sunday before`,
    );
  } finally {
    await db`delete from reading.lookups where user_id = ${userId} and device_id = ${deviceId}::uuid`;
    const [left] = await db<{ n: number }[]>`
      select count(*)::int as n from reading.lookups where user_id = ${userId} and device_id = ${deviceId}::uuid
    `;
    assert("the week-across-month case leaves no reading.lookups behind", left.n === 0, `${left.n} rows left`);
    if (goalId) {
      await db`delete from goals.commitments where goal_id = ${goalId} and user_id = ${userId}`;
      await db`delete from goals.goals where id = ${goalId} and user_id = ${userId}`;
    }
    await db.end();
  }
}

// RP-99, RP-100: Hoy and Semana read a goal with no end as open and a habit with no goal apart,
// in the statements they already spend.
async function runEndlessAndLooseCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { loadWeek } = await import("@/lib/queries/week");
  const { getPerson } = await import("@/lib/session");
  const { todayInZone } = await import("@/lib/zone");

  const person = await getPerson();
  if (!person) throw new Error("runEndlessAndLooseCheck: no verified session");
  const today = todayInZone();
  console.log(`\nmodule 913 check — ${new Date().toISOString()} (today ${today})`);

  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  let goalId: string | null = null;
  let habitId: string | null = null;
  try {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, 'check-913 endless', null, now() - interval '3 days')
      returning id
    `;
    goalId = goal.id;
    const [habit] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
      values (${person.id}, null, 'check-913 loose', 'daily', 'tap', now() - interval '3 days')
      returning id
    `;
    habitId = habit.id;
    const day = await loadDay(today);
    assert(
      "913: Hoy draws a goal with no end as open, and no goal groups the loose habit",
      day.goals.some((g) => g.id === goalId && g.horizon === null) &&
        day.loose.commitments.some((c) => c.id === habitId && c.goalId === null) &&
        day.loose.slots.some((slot) => slot.commitmentId === habitId),
      `goals=${day.goals.length} loose=${JSON.stringify(day.loose.commitments.map((c) => c.id))}`,
    );
    const week = await loadWeek(today);
    assert(
      "913: Semana draws the goal with no end and the loose habit, with a tally for each day",
      week.goals.some((g) => g.id === goalId) &&
        week.loose.commitments.some((c) => c.id === habitId) &&
        week.loose.days.length === 7,
      `goals=${week.goals.length} loose=${week.loose.commitments.length}`,
    );
  } finally {
    if (habitId) await db`delete from goals.commitments where id = ${habitId}`;
    if (goalId) await db`delete from goals.goals where id = ${goalId}`;
    await db.end();
  }
}

void (async () => {
  try {
    if (process.argv.includes("--degraded-child")) {
      await runDegradedChild();
      // `failed` is this process's own — a fresh process per run, so this
      // reads only what `reportDegradedRun` just asserted, nothing carried
      // over from a previous invocation.
      process.exit(failed ? 1 : 0);
    } else {
      await runMain();
    }
  } catch (error) {
    console.error(`FAILED  ${(error as Error).message}`);
    process.exit(1);
  }
})();

// RP-74: a goal from 5 to 20 October 2010 at 620 a month plans 320 on Hoy,
// and the pace line on the 20th reads that share: 191 is under 60 %, 192 not.
async function runSharedMonthLineCheck(): Promise<void> {
  const { loadDay } = await import("@/lib/queries/day");
  const { getPerson } = await import("@/lib/session");

  const person = await getPerson();
  if (!person) throw new Error("runSharedMonthLineCheck: no verified session");
  const userId = person.id;
  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  let goalId: string | null = null;
  try {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
      values (${userId}, 'shared month-line probe', '2010-10-21'::date, 'searches', 'searches', 620,
              '2010-10-05T12:00:00-05:00'::timestamptz)
      returning id
    `;
    goalId = goal.id;
    const [commitment] = await db<{ id: string }[]>`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${userId}, ${goalId}, 'shared month-line quantity', 'daily', 'quantity', 10, 'searches',
              '2010-10-05T12:00:00-05:00'::timestamptz)
      returning id
    `;
    await db`
      insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
      values (${userId}, ${goalId}, ${commitment.id}, '2010-10-06'::date, 191)
    `;
    const under = (await loadDay("2010-10-20")).monthLine[goalId];
    assert(
      "RP-74: Hoy's month line plans the share, 320 of 620, and 191 of it on the 20th is under pace",
      under?.planned === 320 && under.reached === 191 && under.underPace === true,
      `monthLine = ${JSON.stringify(under)}`,
    );
    await db`
      insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
      values (${userId}, ${goalId}, ${commitment.id}, '2010-10-07'::date, 1)
    `;
    const on = (await loadDay("2010-10-20")).monthLine[goalId];
    assert(
      "RP-74: 192 of the 320 share sits on the line and is not under pace",
      on?.planned === 320 && on.reached === 192 && on.underPace === false,
      `monthLine = ${JSON.stringify(on)}`,
    );
  } finally {
    if (goalId) await db`delete from goals.goals where id = ${goalId}`;
    await db.end();
  }
}
