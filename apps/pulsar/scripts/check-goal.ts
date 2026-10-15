// Proves `loadGoal`'s fan-out the same way `scripts/check-day.ts`
// proves `loadDay`'s: by counting statements off the driver's own wire, not
// off `goal.ts`'s source text, and by redeeming this lane's own
// `private/session-<lane>.json` cookie rather than typing anything into
// `/entrar`. Read that file first — the technique below (debug-hook
// instrumentation, one begin/one commit per connection, an exact match on
// `postgres`'s own type-fetch text, capped at one per connection and zero
// warm) is copied from it verbatim, not reinvented.
//
// A SQL-text assertion that only checks `"goals"."goals"` appears *somewhere* in the reading
// statement is too weak: a `from` bound rewritten as a hardcoded
// `sql`'0001-01-01'::date`` still passes — the `to` bound's own reference
// carried the whole assertion. `assertReadingBounds` below extracts the
// `between <from> and <to>` clause `goalSpan`'s own two subqueries land in
// (`lib/queries/goal.ts`) and checks each side on its own. And that
// text-only check also passes a bound that names `"goals"."goals"` but reads
// the wrong row or the wrong column — both bounds on `horizon`, say. Text
// alone cannot tell; `assertBoundsResolveToGoalRow` below replays the exact
// `from`/`to` fragments the wire carried, values included, and compares what
// they resolve to against the goal's own `created_at` and `horizon`, fetched
// independently.
//
// The fixture also used to retire its only quantity commitment, forcing
// `declaredTotal` to zero on purpose — the same value a mutation that zeroes
// `declaredTotal` whenever evidence is unreadable also produces, so the
// degraded child's own assertion could never tell the two apart. It now
// keeps that commitment active with one real declared fact instead
// (`seedMixedMeasureGoal`), so the degraded child's declared-total assertion
// has a nonzero number a bug can actually miss.
//
// This script seeds its own goal every run — through `createGoal`,
// `addCommitment` and `declareFact`, never a raw INSERT — the same doors a
// person's own screen uses.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";

// A plain npm package, not a `@/`-rooted specifier: safe to import before
// `installStubs` runs, the same way `lib/queries/goal.ts` itself imports it.
import { sql, type SQL } from "drizzle-orm";
// The session pooler, bypassing RLS the same way `scripts/check-goal-
// actions.ts` does for its own backdated fixtures — never the app's own
// `DATABASE_URL` role, and loaded here (a plain npm package, static import)
// before `installStubs` ever runs, so it is never the wrapped, counted
// `postgres` `installStubs` hands `loadGoal` itself.
import { assertSuiteDatabase } from "@repo/harness-registry";
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

// `mint-session.ts`'s own file, read the same way `check-day.ts` reads it.
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

const wireCalls: DebugCall[] = [];

// "none": the real registry reader, against the real (empty, for a fresh
// identity) `reading.lookups`. "stub": the reader replaced with three known
// rows, to prove the sum against a number no real row on this database can
// produce for any harness identity. "degraded": the reader replaced with one
// that always rejects, to prove RNP-04's failure path.
type StubMode = "none" | "stub" | "degraded";

const STUB_QUANTITIES = [5, 3, 2];
const STUB_TOTAL = STUB_QUANTITIES.reduce((a, b) => a + b, 0);

function todayInBogota(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());
}

/**
 * Installs every stub `@/lib/queries/goal.ts`'s own import chain needs to run
 * outside Next, the reader override named by `mode` included. Has to run
 * before the first `@/`-rooted import — `check-day.ts`'s own warning, word
 * for word: `_load` binds each `require` once, and a module already required
 * is a module this cannot reach again.
 */
function installStubs(cookies: StoredCookie[], mode: StubMode): void {
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
    if (mode === "degraded" && request === "./reading-lookups") {
      return {
        readReadingLookups: async () => {
          throw new Error("check-goal.ts: simulated reading-lookups failure");
        },
      };
    }
    if (mode === "stub" && request === "./reading-lookups") {
      return {
        readReadingLookups: async () => {
          const day = todayInBogota();
          return STUB_QUANTITIES.map((quantity) => ({
            day,
            quantity,
            unit: "searches",
            labelKey: "sources.readingLookups",
          }));
        },
      };
    }
    // Wraps `postgres` itself once, so every statement `db/client.ts`'s pool
    // sends is counted — `prepare`, `max` and `idle_timeout` pass through
    // untouched, the pool under measurement stays the pool `loadGoal` gets.
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

// `postgres`'s own default `fetch_types: true` (never set in `db/client.ts`)
// sends exactly this query the first time a physical connection is ever
// used — read verbatim off `node_modules/postgres/src/connection.js`'s own
// `fetchArrayTypes`, the same text `check-day.ts` matches. An exact match on
// the whole statement, whitespace collapsed: a bare `pg_catalog.pg_type`
// substring match would let a statement that merely *mentions* that catalog
// net itself out of the count it is supposed to inflate.
const TYPE_FETCH_QUERY_TEXT =
  "select b.oid, b.typarray from pg_catalog.pg_type a left join pg_catalog.pg_type b " +
  "on b.oid = a.typelem where a.typcategory = 'a' group by b.oid, b.typarray order by b.oid";

function isTypeFetchText(query: string): boolean {
  return query.replace(/\s+/g, " ").trim().toLowerCase() === TYPE_FETCH_QUERY_TEXT;
}

// The settle statement's third `set_config` argument is the search path
// `withGoalsDb`/`withReadingDb` chose (`lib/session.ts`) — read from
// `parameters`, not guessed from the query text.
function labelConnection(calls: DebugCall[]): string {
  const settle = calls.find((call) => /set_config/i.test(call.query));
  const searchPath = typeof settle?.parameters[2] === "string" ? settle.parameters[2] : "";
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
  // sends on a connection's first-ever use — what `loadGoal` itself chose to
  // send. The settle (`set_config`) statement is not netted out here: it is
  // one of `loadGoal`'s own two statements per connection, the same way
  // `check-day.ts` counts it for `loadDay`.
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

function assert(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!ok) failed = true;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  for (;;) {
    index = text.indexOf(needle, index);
    if (index === -1) return count;
    count++;
    index += needle.length;
  }
}

/**
 * Splits the reading statement's own `between <from> and <to>` clause
 * (`reading-lookups.ts`'s `civilDay between ${from} and ${to}`) into the two
 * bound expressions `goalSpan` built (`lib/queries/goal.ts`), by tracking
 * paren depth rather than assuming either side is wrapped in one: a bound
 * rewritten as a bare literal (the mutation this function exists to catch)
 * has no parens of its own, and a naive `(select ...)` match would silently
 * skip right past it. Returns `null` when no top-level `and` is found at all
 * — a shape this file has never seen sent, and one this function must fail
 * closed on rather than guess at.
 */
function splitBetweenBounds(query: string): { from: string; to: string } | null {
  const between = /\bbetween\b/i.exec(query);
  if (!between) return null;

  let i = between.index + between[0].length;
  const fromStart = i;
  let depth = 0;
  let andIndex = -1;
  for (; i < query.length; i++) {
    const ch = query[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && /^\s+and\b/i.test(query.slice(i))) {
      andIndex = i;
      break;
    }
  }
  if (andIndex === -1) return null;
  const fromText = query.slice(fromStart, andIndex).trim();

  const andWord = /^\s+and\b/i.exec(query.slice(andIndex));
  if (!andWord) return null;
  let j = andIndex + andWord[0].length;
  const toStart = j;
  depth = 0;
  let toEnd = query.length;
  for (; j < query.length; j++) {
    const ch = query[j];
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) {
        toEnd = j;
        break;
      }
      depth--;
    }
  }
  const toText = query.slice(toStart, toEnd).trim();

  return { from: fromText, to: toText };
}

// The reading connection's own application statement, net of its settle,
// its bracket and any type-fetch — the one statement `readReadingLookups`
// sends, found the same bounded way `analyzeGroup` bounds everything else.
function findReadingAppCall(calls: DebugCall[]): DebugCall | undefined {
  for (const [, groupCalls] of groupByConnection(calls)) {
    if (labelConnection(groupCalls) !== "reading") continue;
    return groupCalls.find((call) => {
      const normalized = normalizeStatement(call.query);
      return (
        !normalized.startsWith("begin") &&
        normalized !== "commit" &&
        normalized !== "rollback" &&
        !/set_config/i.test(call.query) &&
        !isTypeFetchText(call.query)
      );
    });
  }
  return undefined;
}

/**
 * `"goals"."goals"` named
 * once in the `from` bound and once in the `to` bound, checked independently
 * rather than counted across the whole statement. A count of two across the
 * whole statement would still pass if one bound carried both references and
 * the other none — this reads the two bounds apart first, the way `goalSpan`
 * itself built them apart, and fails on either alone missing its reference.
 */
function assertReadingBounds(label: string, calls: DebugCall[]): void {
  const call = findReadingAppCall(calls);
  if (!call) {
    assert(`${label} run's reading statement bounds "goals"."goals" on both from and to`, false, "no reading application statement found on the wire");
    return;
  }
  const bounds = splitBetweenBounds(call.query);
  if (!bounds) {
    assert(
      `${label} run's reading statement bounds "goals"."goals" on both from and to`,
      false,
      `no "between ... and ..." clause found in: ${call.query.replace(/\s+/g, " ").trim()}`,
    );
    return;
  }
  const fromOk = countOccurrences(bounds.from, `"goals"."goals"`) === 1;
  const toOk = countOccurrences(bounds.to, `"goals"."goals"`) === 1;
  assert(
    `${label} run's reading statement bounds "goals"."goals" on both from and to`,
    fromOk && toOk,
    `from = ${bounds.from} | to = ${bounds.to}`,
  );
}

/**
 * Turns a bound fragment's own wire text — `$3`, `$4`, literal SQL and
 * all — back into an `SQL` object drizzle can execute, bound to the exact
 * values `call.parameters` carried, not to values this file already knows
 * from having built the goal itself. Splitting on `$<digits>` and rebuilding
 * with `sql.raw` for the literal pieces and `${...}` for each value is what
 * lets this replay a hardcoded id or a swapped column exactly as sent —
 * `sql.raw` alone cannot bind a value, and hand-formatting the value into the
 * string would trust this file's own escaping instead of drizzle's.
 */
function rebuildAsSql(text: string, allParams: unknown[]): SQL {
  const parts = text.split(/\$(\d+)/);
  let result: SQL = sql.raw(parts[0] ?? "");
  for (let i = 1; i < parts.length; i += 2) {
    const paramIndex = Number(parts[i]) - 1;
    const literalAfter = parts[i + 1] ?? "";
    result = sql`${result}${allParams[paramIndex]}${sql.raw(literalAfter)}`;
  }
  return result;
}

/**
 * The assertion `assertReadingBounds` above cannot make: that a bound naming
 * `"goals"."goals"` actually *resolves* to the goal's own row and the right
 * column. A bound rewritten to read a hardcoded id, or to read `horizon`
 * on both sides, still names `"goals"."goals"` once each — the text-only
 * check goes green either way. This replays the exact `from`/`to` fragments
 * `readReadingLookups` sent, values included, inside a fresh `withReadingDb`
 * transaction — "the way the reading transaction sees them" — and compares
 * the result to the goal's own `created_at` and `horizon`, fetched
 * independently through `withGoalsDb`. Never by calling `goalSpan` again:
 * that would just repeat whatever bug it carries, not catch it.
 */
async function assertBoundsResolveToGoalRow(goalId: string, calls: DebugCall[]): Promise<void> {
  const label = "the reading statement's bounds resolve to the goal's own created_at and horizon";
  const call = findReadingAppCall(calls);
  if (!call) {
    assert(label, false, "no reading application statement found on the wire");
    return;
  }
  const bounds = splitBetweenBounds(call.query);
  if (!bounds) {
    assert(label, false, `no "between ... and ..." clause found in: ${call.query.replace(/\s+/g, " ").trim()}`);
    return;
  }

  const { withGoalsDb, withReadingDb } = await import("@/lib/session");
  const { TIME_ZONE } = await import("@/lib/zone");

  const fromFragment = rebuildAsSql(bounds.from, call.parameters);
  const toFragment = rebuildAsSql(bounds.to, call.parameters);

  const [resolved] = await withReadingDb((tx) =>
    tx.execute<{ from_value: string | null; to_value: string | null }>(
      sql`select ${fromFragment} as from_value, ${toFragment} as to_value`,
    ),
  );

  const [expected] = await withGoalsDb((tx) =>
    tx.execute<{ expected_from: string; expected_to: string }>(sql`
      select (g.created_at at time zone ${TIME_ZONE})::date as expected_from, g.horizon - 1 as expected_to
      from "goals"."goals" g where g.id = ${goalId}
    `),
  );

  const ok =
    !!resolved &&
    !!expected &&
    resolved.from_value === expected.expected_from &&
    resolved.to_value === expected.expected_to;
  assert(
    label,
    ok,
    `resolved from=${resolved?.from_value} to=${resolved?.to_value} | ` +
      `expected from=${expected?.expected_from} to=${expected?.expected_to}`,
  );
}

/**
 * Prints every connection's own bracket and statement counts, and
 * asserts on all of it — the same shape `check-day.ts`'s `reportRun` asserts,
 * plus `assertReadingBounds` above: every connection brackets exactly one
 * `begin` and one `commit`, never a `rollback`, never a second one of
 * either; at most one type-fetch statement per connection, none at all on a
 * warm run; the application statements, net of that bracket and of any
 * legitimate type-fetch, total exactly four — asserted on the cold run too;
 * when the caller passed `overlap`, the second transaction started while the
 * first was held (decided by call order, cold run included); and the
 * reading statement's own `from`/`to` bounds each name the goal's row.
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

  assertReadingBounds(label, calls);
}

// Whole civil days added to a `YYYY-MM-DD` string, by midday UTC — the same
// technique `seed-goal.ts` and `lib/zone.ts`'s own `weekOf` use.
function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(date);
}

// The declared half of `measureTotal`: a real fact, written through
// `declareFact` like any other, never a row this file inserts by hand.
const DECLARED_QUANTITY = 7;

/**
 * A goal measured in one unit ("searches") by two commitments at once, both
 * active: a quantity commitment carrying one real declared fact, and an
 * evidence commitment naming the same unit. Retiring the quantity commitment
 * used to be how this fixture forced `declaredTotal` to zero — which is
 * exactly the value a mutation that zeroes `declaredTotal` whenever evidence
 * is unreadable can also produce, so the validator's own assertion could
 * never tell the two apart. Keeping the quantity commitment active, with a
 * nonzero fact, is what makes the degraded child's declared total (7) a
 * number that mutation cannot fake. Never a raw INSERT: `createGoal`,
 * `addCommitment` and `declareFact` are the same three actions a person's
 * own screen drives.
 */
async function seedMixedMeasureGoal(): Promise<string> {
  const { createGoal, addCommitment } = await import("@/app/actions/plan");
  const { declareFact } = await import("@/app/actions/facts");
  const { todayInZone } = await import("@/lib/zone");

  const today = todayInZone();
  const goal = await createGoal({
    name: "check-goal.ts probe — medida mixta",
    horizon: addDays(today, 30),
  });
  if (!goal.ok) throw new Error(`createGoal: ${goal.error}`);

  const counter = await addCommitment({
    goalId: goal.goalId,
    name: "check-goal.ts probe — contador manual",
    cadenceKind: "daily",
    satisfaction: "quantity",
    targetQuantity: 1,
    unit: "searches",
  });
  if (!counter.ok) throw new Error(`addCommitment(counter): ${counter.error}`);

  const fact = await declareFact({ commitmentId: counter.commitmentId, quantity: DECLARED_QUANTITY });
  if (!fact.ok) throw new Error(`declareFact: ${fact.error}`);

  const evidence = await addCommitment({
    goalId: goal.goalId,
    name: "check-goal.ts probe — evidencia de lectura",
    cadenceKind: "daily",
    satisfaction: "evidence",
    sourceKey: "reading_lookups",
    threshold: 1,
  });
  if (!evidence.ok) throw new Error(`addCommitment(evidence): ${evidence.error}`);

  return goal.goalId;
}

const CHILD_MARKER = "CHILD_JSON ";

type ChildResult = {
  evidence: string;
  measureTotal: number;
  measureUnit: string | null;
  // `view.weeks.length` (RP-17): carried out of the child alongside
  // `measureTotal` so `runWeeksCheck` can prove `weeks` survives the same
  // degraded reading transaction `measureTotal` already survives (RNP-04).
  weeksCount: number;
  // `view.weeks.map(w => w.total)`: `weeksCount` alone cannot tell a degraded
  // run that still reads three rows apart from one that reads three rows of
  // `0` — a bug that drops the declared half along with the unreadable
  // evidence half would still pass a bare length check. `runWeeksCheck`
  // compares this against the goal's own declared-only totals.
  weekTotals: number[];
};

/**
 * The child's own report: the goals connection's usual bracket, the reading
 * connection's own (a normal commit for `stub`, a rollback for `degraded` —
 * `sql.begin` answers a thrown callback with `rollback`, never `commit`,
 * `node_modules/postgres/src/index.js`'s own `begin()`), and the total
 * application-statement count — never left uncounted the way independent
 * validation found `check-day.ts`'s own degraded child once did.
 */
function reportChildRun(label: string, calls: DebugCall[], expectReadingCommit: boolean): void {
  const groups = [...groupByConnection(calls).entries()].map(([connection, groupCalls]) =>
    analyzeGroup(connection, groupCalls),
  );
  const totalApplication = groups.reduce((sum, group) => sum + group.applicationCount, 0);

  console.log(
    `\n${label} child's own wire — ${calls.length} statement(s) across ${groups.length} connection(s), ` +
      `${totalApplication} application statement(s)`,
  );
  for (const group of groups) {
    console.log(
      `  ${group.label.padEnd(8)} cid=${group.connection} begin=${group.beginCount} commit=${group.commitCount} ` +
        `rollback=${group.rollbackCount}, application=${group.applicationCount}, type-fetch=${group.typeFetchCount}`,
    );
  }

  const overCapped = groups.filter((group) => group.typeFetchCount > 1);
  assert(
    `${label} child's connections send at most one type-fetch statement each`,
    overCapped.length === 0,
    overCapped.length === 0
      ? `${groups.length} connection(s), each type-fetch <= 1`
      : overCapped.map((group) => `cid=${group.connection} (${group.label}) type-fetch=${group.typeFetchCount}`).join("; "),
  );

  const goalsGroups = groups.filter((group) => group.label === "goals");
  const readingGroups = groups.filter((group) => group.label === "reading");
  assert(
    `${label} child opens exactly one goals connection and one reading connection`,
    groups.length === 2 && goalsGroups.length === 1 && readingGroups.length === 1,
    `${groups.length} connection(s): ${groups.map((group) => group.label).join(", ") || "none"}`,
  );

  const goals = goalsGroups[0];
  if (goals) {
    assert(
      `${label} child's goals connection brackets exactly one begin and one commit, no rollback`,
      goals.beginCount === 1 && goals.commitCount === 1 && goals.rollbackCount === 0,
      `begin=${goals.beginCount} commit=${goals.commitCount} rollback=${goals.rollbackCount}`,
    );
  }

  const reading = readingGroups[0];
  if (reading) {
    const readingOk = expectReadingCommit
      ? reading.beginCount === 1 && reading.commitCount === 1 && reading.rollbackCount === 0
      : reading.beginCount === 1 && reading.commitCount === 0 && reading.rollbackCount === 1;
    assert(
      `${label} child's reading connection brackets exactly one begin and one ${expectReadingCommit ? "commit" : "rollback"}`,
      readingOk,
      `begin=${reading.beginCount} commit=${reading.commitCount} rollback=${reading.rollbackCount}`,
    );
  }

  // Neither `stub` nor `degraded` ever lets the reader's own statement reach
  // the wire (the whole `readReadingLookups` module is replaced before
  // `loadGoal` ever imports it), so both children total the goals
  // connection's two statements (settle, query) plus the reading
  // connection's settle alone — one round trip cheaper than the four
  // `reportRun` bounds a real reader to, and a fact this file measures
  // rather than assumes.
  const expectedTotal = 3;
  assert(
    `${label} child issues ${expectedTotal} application statements, no more`,
    totalApplication === expectedTotal,
    `${totalApplication} application statement(s) of ${calls.length} on the wire`,
  );
}

async function runChild(mode: "stub" | "degraded", goalId: string): Promise<void> {
  installStubs(loadCookies(), mode);

  const { loadGoal } = await import("@/lib/queries/goal");

  const start = wireCalls.length;
  const view = await loadGoal(goalId);
  reportChildRun(mode, wireCalls.slice(start), mode === "stub");
  if (!view) throw new Error(`runChild: loadGoal(${goalId}) returned null — the seeded goal is gone`);

  const result: ChildResult = {
    evidence: view.evidence,
    measureTotal: view.measureTotal,
    measureUnit: view.measureUnit,
    weeksCount: view.weeks.length,
    weekTotals: view.weeks.map((week) => week.total),
  };
  console.log(`${CHILD_MARKER}${JSON.stringify(result)}`);
}

function runChildProcess(mode: "stub" | "degraded", goalId: string): ChildResult {
  let output: string;
  try {
    output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--env-file=.env.local", "scripts/check-goal.ts", `--child=${mode}`, `--goal=${goalId}`],
      { cwd: process.cwd(), env: process.env, encoding: "utf8" },
    );
  } catch (error) {
    // The child's own PASS/FAIL lines are on its stdout, lost the moment
    // `execFileSync` throws unless printed here — the only place a caller of
    // this function still has them.
    const execError = error as { stdout?: string; stderr?: string; message: string };
    if (execError.stdout) console.log(execError.stdout);
    if (execError.stderr) console.error(execError.stderr);
    throw new Error(`${mode} child process failed: ${execError.message}`);
  }
  console.log(output);
  const line = output.split("\n").find((row) => row.startsWith(CHILD_MARKER));
  if (!line) throw new Error(`${mode} child printed no result:\n${output}`);
  return JSON.parse(line.slice(CHILD_MARKER.length)) as ChildResult;
}

/**
 * RP-14: a goal names one measure, set by "the first commitment that
 * measures something" and never again. A second `quantity` commitment
 * naming another unit must neither rename `goals.measure_name`/`measure_unit`
 * nor make the goal's own total stop counting the first commitment's own
 * facts — `measureOf` sums by unit, so a silent rename would zero a real
 * declared history the moment a second measure is added. Built through
 * `createGoal`, `addCommitment` and `declareFact` alone, the same doors a
 * person's own screen uses; the measure columns are read back with one plain
 * `select`, never through `addCommitment` again.
 */
async function runMeasureRenameCheck(): Promise<void> {
  const { createGoal, addCommitment } = await import("@/app/actions/plan");
  const { declareFact } = await import("@/app/actions/facts");
  const { loadGoal } = await import("@/lib/queries/goal");
  const { withGoalsDb } = await import("@/lib/session");
  const { todayInZone } = await import("@/lib/zone");

  const today = todayInZone();
  const goal = await createGoal({
    name: "check-goal.ts probe — RP-14 measure guard",
    horizon: addDays(today, 30),
  });
  if (!goal.ok) throw new Error(`runMeasureRenameCheck: createGoal failed: ${goal.error}`);

  const first = await addCommitment({
    goalId: goal.goalId,
    name: "check-goal.ts probe — minutos",
    cadenceKind: "daily",
    satisfaction: "quantity",
    targetQuantity: 10,
    unit: "min",
  });
  if (!first.ok) throw new Error(`runMeasureRenameCheck: addCommitment(first) failed: ${first.error}`);

  const FIRST_QUANTITY = 5;
  const fact = await declareFact({ commitmentId: first.commitmentId, quantity: FIRST_QUANTITY });
  if (!fact.ok) throw new Error(`runMeasureRenameCheck: declareFact failed: ${fact.error}`);

  const second = await addCommitment({
    goalId: goal.goalId,
    name: "check-goal.ts probe — tarjetas",
    cadenceKind: "daily",
    satisfaction: "quantity",
    targetQuantity: 10,
    unit: "cards",
  });
  if (!second.ok) throw new Error(`runMeasureRenameCheck: addCommitment(second) failed: ${second.error}`);

  const [row] = await withGoalsDb((tx) =>
    tx.execute<{ measure_name: string | null; measure_unit: string | null }>(
      sql`select measure_name, measure_unit from "goals"."goals" where id = ${goal.goalId}`,
    ),
  );
  assert(
    "a goal's measure is named once, by its first quantity commitment, and a second one in another unit never renames it (RP-14)",
    row?.measure_name === "min" && row?.measure_unit === "min",
    `measure_name=${row?.measure_name} measure_unit=${row?.measure_unit}`,
  );

  const view = await loadGoal(goal.goalId);
  if (!view) throw new Error(`runMeasureRenameCheck: loadGoal(${goal.goalId}) returned null — the seeded goal is gone`);
  assert(
    "the goal's own total still counts the first commitment's own facts once a second commitment names another unit",
    view.measureTotal === FIRST_QUANTITY && view.measureUnit === "min",
    `measureTotal=${view.measureTotal} measureUnit=${view.measureUnit}`,
  );
}

/**
 * A goal that measures owns its commitments' unit: a quantity
 * commitment sent with another unit is stored with the goal's.
 */
async function runCommitmentUnitCheck(): Promise<void> {
  const { createGoal, addCommitment } = await import("@/app/actions/plan");
  const { withGoalsDb } = await import("@/lib/session");

  const goal = await createGoal({ name: "check-goal.ts probe — 361 unit", horizon: "2099-12-31" });
  if (!goal.ok) throw new Error(`runCommitmentUnitCheck: createGoal failed: ${goal.error}`);

  const quantity = (name: string, unit: string) =>
    addCommitment({
      goalId: goal.goalId,
      name,
      cadenceKind: "daily",
      satisfaction: "quantity",
      targetQuantity: 3,
      unit,
    });
  const unitOf = async (commitmentId: string) => {
    const [row] = await withGoalsDb((tx) =>
      tx.execute<{ unit: string | null }>(sql`select unit from "goals"."commitments" where id = ${commitmentId}`),
    );
    return row?.unit;
  };

  const first = await quantity("check-goal.ts probe — 361 first", "min");
  const second = await quantity("check-goal.ts probe — 361 second", "cards");
  if (!first.ok || !second.ok) throw new Error("runCommitmentUnitCheck: addCommitment failed");

  assert(
    "the first quantity commitment of a goal names its unit",
    (await unitOf(first.commitmentId)) === "min",
    "unit=min",
  );
  assert(
    "a quantity commitment sent with another unit on a measured goal stores the goal's unit (361)",
    (await unitOf(second.commitmentId)) === "min",
    `unit=${await unitOf(second.commitmentId)}`,
  );
}

/**
 * RP-15's own race: two tabs submitting overlapping
 * spans (1–4 and 2–5) on the same goal both landed under `READ COMMITTED`,
 * each reading "no overlap yet" before either had committed. `addPhase`'s own
 * `pg_advisory_xact_lock`, keyed on the goal's id and taken as the first
 * statement of its transaction, serialises the two calls: the second blocks
 * until the first commits, then re-reads the phases the first one just wrote
 * and is refused. A fresh goal, created here and never reused, so no other
 * lane's own phases can be in the way — `addPhase`'s overlap read is scoped
 * to this `goalId` alone regardless.
 */
async function runPhaseOverlapRaceCheck(): Promise<void> {
  const { addPhase, createGoal } = await import("@/app/actions/plan");

  const goal = await createGoal({
    name: "check-goal.ts probe — phase overlap race",
    horizon: "2099-12-31",
  });
  if (!goal.ok) throw new Error(`runPhaseOverlapRaceCheck: createGoal failed: ${goal.error}`);

  const [first, second] = await Promise.all([
    addPhase({
      goalId: goal.goalId,
      aim: "race a",
      startsOn: "2030-01-01",
      endsOn: "2030-01-28",
    }),
    addPhase({
      goalId: goal.goalId,
      aim: "race b",
      startsOn: "2030-01-08",
      endsOn: "2030-02-04",
    }),
  ]);

  const results = [first, second];
  const landed = results.filter((result) => result.ok);
  const refused = results.filter((result) => !result.ok);

  assert(
    "exactly one of two concurrent addPhase calls with overlapping spans lands on the same goal (RP-15)",
    landed.length === 1 && refused.length === 1,
    `results = ${JSON.stringify(results)}`,
  );
  assert(
    "the refused call names the overlap, never a generic failure",
    refused.length === 1 && !refused[0].ok && refused[0].error === "plan.errors.phaseOverlap",
    `refused = ${JSON.stringify(refused[0])}`,
  );
}

// One quantity of `min` per week, on that week's own known day: `openedOn`
// itself (week 1), week 2's own Monday, and today (week 3) — `loadGoal`'s own
// `weeks` (RP-17) has exactly one fact to place in each row it returns.
const WEEK_TOTALS = [5, 8, 3];
// `openedOn` is the Wednesday of the week two Mondays back, so `today` always
// sits in week 3 whatever weekday the check runs on, and week 1 is partial.
const OPENED_WEEKDAY_OFFSET = 2;

/**
 * RP-17: `loadGoal`'s own `weeks`, off a goal whose `created_at` sits three
 * weeks back — set through the session pooler, the only door open to that
 * column at all (`goals.goals` grants `authenticated` UPDATE on
 * `measure_name`/`measure_unit` and `name`/`archived_at` alone, never
 * `created_at`) — with one declared fact seeded straight into `goals.facts`
 * on each week's own known day: the first two are further back than
 * `declareFact`'s own `PAST_DAY_LIMIT` (7) can reach, so seeded through the
 * granted INSERT columns directly, the same technique `declareFact` itself
 * uses (`day`, `quantity` — never `written_at`), never through the action.
 * `loadGoal` still issues four statements against this goal (the "no new statement" promise), and the reading transaction forced to throw
 * still returns three weeks whose own totals still match the declared seed
 * — the declared half alone, RNP-04 carried from `measureTotal` into the
 * review, never a length that happens to be three while every total reads
 * `0`. A second, smaller goal proves the other half of RP-17's own evidence
 * path: two commitments naming the same evidence source must not double its
 * rows into one week's own total, the one case `matchingSourceKeys`'s `Set`
 * exists for (`lib/queries/goal.ts`) — proven through the `stub` child mode,
 * the only door onto a known evidence quantity at all (no harness identity
 * carries a real `reading.lookups` row). Both goals are torn down by their
 * own id, which cascades to their commitments and facts alike (`ON DELETE
 * CASCADE` on both foreign keys) — `goals.goals` grants no DELETE to
 * `authenticated` at all, so the session pooler is the only door out too.
 */
async function runWeeksCheck(): Promise<void> {
  const { createGoal, addCommitment } = await import("@/app/actions/plan");
  const { loadGoal } = await import("@/lib/queries/goal");
  const { getPerson, withGoalsDb } = await import("@/lib/session");
  const { todayInZone, weekOf } = await import("@/lib/zone");
  const { weekSpan } = await import("@/lib/day/weeks");

  const person = await getPerson();
  if (!person) throw new Error("runWeeksCheck: no settled session");

  const today = todayInZone();
  const openedOn = addDays(weekOf(today)[0], -14 + OPENED_WEEKDAY_OFFSET);
  const openedDaysBack = Math.round(
    (new Date(`${today}T12:00:00Z`).getTime() - new Date(`${openedOn}T12:00:00Z`).getTime()) / 86_400_000,
  );
  const knownDays = [openedOn, weekSpan(openedOn, 2, 2).startsOn, today];

  const goal = await createGoal({
    name: "check-goal.ts probe — RP-17 semanas",
    horizon: addDays(today, 60),
  });
  if (!goal.ok) throw new Error(`runWeeksCheck: createGoal failed: ${goal.error}`);
  const goalId = goal.goalId;

  const commitment = await addCommitment({
    goalId,
    name: "check-goal.ts probe — RP-17 medida",
    cadenceKind: "daily",
    satisfaction: "quantity",
    targetQuantity: 1,
    unit: "min",
  });
  if (!commitment.ok) throw new Error(`runWeeksCheck: addCommitment failed: ${commitment.error}`);

  // Torn down in `finally` alongside `goalId` — set only once the dedupe
  // fixture below actually lands, so a failure partway through still leaves
  // nothing behind.
  let dedupeGoalId: string | null = null;

  const migrationDb = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    // Bogota carries no DST (`lib/zone.ts`'s own fixed offset), so shifting
    // the instant back by whole days shifts its own civil date by exactly
    // that many days too — the same `openedOn` this function already
    // computed from `today`, never a second, independent calculation.
    const backdatedAt = new Date(Date.now() - openedDaysBack * 86_400_000);
    await migrationDb`update goals.goals set created_at = ${backdatedAt} where id = ${goalId}`;

    await withGoalsDb(async (tx) => {
      for (let i = 0; i < knownDays.length; i++) {
        await tx.execute(sql`
          insert into "goals"."facts" (user_id, commitment_id, goal_id, day, quantity)
          values (${person.id}, ${commitment.commitmentId}, ${goalId}, ${knownDays[i]}, ${WEEK_TOTALS[i]})
        `);
      }
    });

    const start = wireCalls.length;
    const { result: view, overlap } = await withOverlap(() => loadGoal(goalId));
    const calls = wireCalls.slice(start);
    reportRun("weeks", calls, true, overlap);
    await assertBoundsResolveToGoalRow(goalId, calls);
    if (!view) throw new Error(`runWeeksCheck: loadGoal(${goalId}) returned null — the seeded goal is gone`);

    assert(
      "RP-17: loadGoal returns exactly three weeks for a goal opened on a Wednesday two weeks back",
      view.weeks.length === 3,
      `weeks = ${JSON.stringify(view.weeks.map((week) => ({ index: week.index, total: week.total })))}`,
    );

    assert(
      "RP-17: week 1 starts on the Wednesday the goal opened, week 2 on a Monday",
      view.weeks[0]?.startsOn === openedOn && view.weeks[1]?.startsOn === weekSpan(openedOn, 2, 2).startsOn &&
        new Date(`${view.weeks[1]?.startsOn}T12:00:00Z`).getUTCDay() === 1,
      `starts = ${JSON.stringify(view.weeks.map((week) => week.startsOn))}, openedOn = ${openedOn}`,
    );

    const totals = view.weeks.map((week) => week.total);
    assert(
      "RP-17: each week's own total matches the fact seeded on its own known day",
      JSON.stringify(totals) === JSON.stringify(WEEK_TOTALS),
      `expected ${JSON.stringify(WEEK_TOTALS)}, got ${JSON.stringify(totals)}`,
    );

    const weeksSum = view.weeks.reduce((sum, week) => sum + week.total, 0);
    assert(
      "measureTotal equals the sum of weeks[].total, up to today",
      view.measureTotal === weeksSum,
      `measureTotal=${view.measureTotal}, sum(weeks)=${weeksSum}`,
    );

    const degraded = runChildProcess("degraded", goalId);
    assert(
      "with the reading transaction forced to throw, weeks still has three rows (RNP-04 carried into the review)",
      degraded.weeksCount === 3,
      `weeksCount = ${degraded.weeksCount}`,
    );
    // This fixture names no evidence commitment, so its declared-only totals
    // are `WEEK_TOTALS` whether the reading transaction is read or unreadable
    // — a bug that drops the declared half along with the unreadable
    // evidence half (RNP-04's own failure to carry into `weeks`) would zero
    // these instead, and `weeksCount` alone would never catch it.
    assert(
      "with the reading transaction forced to throw, each week's own total still matches the fact seeded on its own known day",
      JSON.stringify(degraded.weekTotals) === JSON.stringify(WEEK_TOTALS),
      `expected ${JSON.stringify(WEEK_TOTALS)}, got ${JSON.stringify(degraded.weekTotals)}`,
    );

    // The evidence half of RP-17: a fresh, unbackdated goal (so it holds
    // exactly one week), named after `reading_lookups` — the only source
    // this app knows, unit `searches` (`evidence_sources` seed row) — by
    // *two* commitments, the one case `matchingSourceKeys`'s `Set`
    // (`lib/queries/goal.ts`) exists for: an array in its place would walk
    // the same three stub rows twice and double the week's own total. The
    // quantity commitment sets the goal's own measure to `searches` (RP-14,
    // the first one wins) and carries no fact of its own, so the week's
    // total is the evidence half alone, never mixed with a declared one.
    const dedupeGoal = await createGoal({
      name: "check-goal.ts probe — RP-17 evidencia duplicada",
      horizon: addDays(today, 30),
    });
    if (!dedupeGoal.ok) throw new Error(`runWeeksCheck: createGoal (dedupe) failed: ${dedupeGoal.error}`);
    dedupeGoalId = dedupeGoal.goalId;

    const dedupeMeasure = await addCommitment({
      goalId: dedupeGoalId,
      name: "check-goal.ts probe — RP-17 medida evidencia",
      cadenceKind: "daily",
      satisfaction: "quantity",
      targetQuantity: 1,
      unit: "searches",
    });
    if (!dedupeMeasure.ok) {
      throw new Error(`runWeeksCheck: addCommitment (dedupe measure) failed: ${dedupeMeasure.error}`);
    }

    for (const label of ["primera", "segunda"]) {
      const evidence = await addCommitment({
        goalId: dedupeGoalId,
        name: `check-goal.ts probe — RP-17 evidencia (${label})`,
        cadenceKind: "daily",
        satisfaction: "evidence",
        sourceKey: "reading_lookups",
        threshold: 1,
      });
      if (!evidence.ok) throw new Error(`runWeeksCheck: addCommitment (dedupe ${label}) failed: ${evidence.error}`);
    }

    const dedupeStub = runChildProcess("stub", dedupeGoalId);
    assert(
      "RP-17: two commitments naming the same evidence source still count its rows once, not twice",
      dedupeStub.weeksCount === 1 && JSON.stringify(dedupeStub.weekTotals) === JSON.stringify([STUB_TOTAL]),
      `weeksCount=${dedupeStub.weeksCount}, weekTotals=${JSON.stringify(dedupeStub.weekTotals)}, expected [${STUB_TOTAL}]`,
    );
    assert(
      "RP-17: the same dedupe holds for measureTotal, not only for weeks[].total",
      dedupeStub.measureTotal === STUB_TOTAL,
      `expected ${STUB_TOTAL}, got ${dedupeStub.measureTotal}`,
    );
  } finally {
    await migrationDb`delete from goals.goals where id = ${goalId}`;
    if (dedupeGoalId) await migrationDb`delete from goals.goals where id = ${dedupeGoalId}`;
    await migrationDb.end();
  }
}

/**
 * A goal created at 23:30 Bogotá is 04:30 UTC of the next day: its first
 * week must still open on the Bogotá day the person made it, never the UTC one.
 */
async function runLateNightOpenCheck(): Promise<void> {
  const { createGoal } = await import("@/app/actions/plan");
  const { loadGoal } = await import("@/lib/queries/goal");
  const { todayInZone } = await import("@/lib/zone");

  const openedOn = addDays(todayInZone(), -3);

  const goal = await createGoal({
    name: "check-goal.ts probe — abierta a las 23:30",
    horizon: addDays(openedOn, 60),
  });
  if (!goal.ok) throw new Error(`runLateNightOpenCheck: createGoal failed: ${goal.error}`);

  const migrationDb = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    // Bogotá is UTC-5 all year.
    const createdAt = new Date(`${openedOn}T23:30:00-05:00`);
    await migrationDb`update goals.goals set created_at = ${createdAt} where id = ${goal.goalId}`;

    const view = await loadGoal(goal.goalId);
    if (!view) throw new Error(`runLateNightOpenCheck: loadGoal(${goal.goalId}) returned null`);

    assert(
      "a goal created at 23:30 Bogotá opens its first week on that Bogotá day, not the UTC one",
      view.weeks[0]?.startsOn === openedOn,
      `expected startsOn ${openedOn}, weeks = ${JSON.stringify(view.weeks.map((week) => week.startsOn))}`,
    );
  } finally {
    await migrationDb`delete from goals.goals where id = ${goal.goalId}`;
    await migrationDb.end();
  }
}

/**
 * RP-27: a goal ends on the day before its horizon. `horizon = today` is the
 * edge both comparisons must cross; archived wins over ended.
 */
async function runEndedCheck(): Promise<void> {
  const { createGoal } = await import("@/app/actions/plan");
  const { loadGoal, listGoals, listGoalsForMetas } = await import("@/lib/queries/goal");
  const { todayInZone } = await import("@/lib/zone");

  const today = todayInZone();
  const seeded: string[] = [];
  const migrationDb = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    for (const name of ["terminada", "en curso", "archivada"]) {
      const goal = await createGoal({ name: `check-goal.ts probe — RP-27 ${name}`, horizon: addDays(today, 60) });
      if (!goal.ok) throw new Error(`runEndedCheck: createGoal failed: ${goal.error}`);
      seeded.push(goal.goalId);
    }
    const [endedId, openId, archivedId] = seeded;
    await migrationDb`update goals.goals set horizon = ${today} where id = ${endedId}`;
    await migrationDb`update goals.goals set horizon = ${addDays(today, 1)} where id = ${openId}`;
    await migrationDb`update goals.goals set horizon = ${addDays(today, -5)}, archived_at = now() where id = ${archivedId}`;

    const ended = await loadGoal(endedId);
    const open = await loadGoal(openId);
    assert(
      "a goal whose horizon is today reads endedOn = yesterday",
      ended?.endedOn === addDays(today, -1),
      `endedOn = ${ended?.endedOn}`,
    );
    assert("a goal whose horizon is tomorrow reads endedOn = null", open?.endedOn === null, `endedOn = ${open?.endedOn}`);

    const before = wireCalls.length;
    const split = await listGoalsForMetas();
    const metasCalls = wireCalls.slice(before);
    // Net of begin/commit and type-fetch: the settle plus the one select.
    const statements = [...groupByConnection(metasCalls).entries()].reduce(
      (sum, [connection, calls]) => sum + analyzeGroup(connection, calls).applicationCount,
      0,
    );
    const where = (list: { id: string }[], id: string) => list.some((goal) => goal.id === id);
    assert(
      "listGoalsForMetas puts the horizon-today goal in ended alone",
      where(split.ended, endedId) && !where(split.open, endedId) && !where(split.archived, endedId),
      `open=${where(split.open, endedId)} ended=${where(split.ended, endedId)} archived=${where(split.archived, endedId)}`,
    );
    assert(
      "listGoalsForMetas puts the horizon-tomorrow goal in open alone",
      where(split.open, openId) && !where(split.ended, openId) && !where(split.archived, openId),
      `open=${where(split.open, openId)} ended=${where(split.ended, openId)} archived=${where(split.archived, openId)}`,
    );
    assert(
      "an archived goal with a past horizon sits in archived alone",
      where(split.archived, archivedId) && !where(split.ended, archivedId) && !where(split.open, archivedId),
      `open=${where(split.open, archivedId)} ended=${where(split.ended, archivedId)} archived=${where(split.archived, archivedId)}`,
    );
    assert("listGoalsForMetas reads the goals in one statement and the evidence in another, each behind its settle (four application statements)",
      statements === 4,
      `${statements} application statement(s)`);

    const listed = await listGoals();
    assert(
      "listGoals omits the ended and the archived goal and keeps the open one",
      !where(listed, endedId) && !where(listed, archivedId) && where(listed, openId),
      `ended=${where(listed, endedId)} archived=${where(listed, archivedId)} open=${where(listed, openId)}`,
    );
  } finally {
    for (const id of seeded) await migrationDb`delete from goals.goals where id = ${id}`;
    await migrationDb.end();
  }
}

/**
 * `loadGoal` reads the plan by month. A goal opened 2010-09-15
 * with a horizon of 2011-08-15, budgets for 2010-10 (720) and 2010-11 (0), one
 * declared fact of 300 in October, a parent with two sub-tasks, all seeded through the session pooler (the one door onto the
 * backdated `created_at` and onto rows the policies would refuse), read with
 * `today` pinned inside the span.
 */
async function runPlanMonthsCheck(): Promise<void> {
  const { createGoal, addCommitment } = await import("@/app/actions/plan");
  const { loadGoal } = await import("@/lib/queries/goal");
  const { getPerson } = await import("@/lib/session");

  const person = await getPerson();
  if (!person) throw new Error("runPlanMonthsCheck: no settled session");

  const goal = await createGoal({ name: "check-goal.ts probe — 129 meses", horizon: "2030-01-01" });
  if (!goal.ok) throw new Error(`runPlanMonthsCheck: createGoal failed: ${goal.error}`);
  const goalId = goal.goalId;
  const commitment = await addCommitment({
    goalId,
    name: "check-goal.ts probe — 129 medida",
    cadenceKind: "daily",
    satisfaction: "quantity",
    targetQuantity: 1,
    unit: "min",
  });
  if (!commitment.ok) throw new Error(`runPlanMonthsCheck: addCommitment failed: ${commitment.error}`);

  const migrationDb = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    await migrationDb`
      update goals.goals set created_at = ${new Date("2010-09-15T12:00:00-05:00")}, horizon = '2011-08-15'
      where id = ${goalId}`;
    await migrationDb`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${goalId}, '2010-10-01', 720), (${person.id}, ${goalId}, '2010-11-01', 0)`;
    await migrationDb`
      insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
      values (${person.id}, ${commitment.commitmentId}, ${goalId}, '2010-10-05', 300)`;
    const [parent] = await migrationDb<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
      values (${person.id}, ${goalId}, 'check-goal.ts probe — 129 madre', '2010-10-01', 500) returning id`;
    const [done] = await migrationDb<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, parent_id, estimate)
      values (${person.id}, ${goalId}, 'check-goal.ts probe — 129 hija hecha', ${parent.id}, 60) returning id`;
    await migrationDb`
      insert into goals.one_offs (user_id, goal_id, name, parent_id, estimate)
      values (${person.id}, ${goalId}, 'check-goal.ts probe — 129 hija abierta', ${parent.id}, 40)`;

    const today = "2010-10-20";
    const start = wireCalls.length;
    const { result: before, overlap } = await withOverlap(() => loadGoal(goalId, today));
    const calls = wireCalls.slice(start);
    reportRun("plan-months", calls, true, overlap);
    await assertBoundsResolveToGoalRow(goalId, calls);
    if (!before) throw new Error("runPlanMonthsCheck: loadGoal returned null");

    assert(
      "RP-16: a goal opened 2010-09-15 with a horizon of 2011-08-15 reads twelve month rows",
      before.months.length === 12 && before.months[0]?.month === "2010-09-01" && before.months[11]?.month === "2011-08-01",
      `${before.months.length} row(s), ${before.months[0]?.month}..${before.months[11]?.month}`,
    );
    const planned = (month: string) => before.months.find((row) => row.month === month)?.planned;
    assert(
      "RP-28: October plans 720, November 0, a month with no budget row null",
      planned("2010-10-01") === 720 && planned("2010-11-01") === 0 && planned("2010-12-01") === null,
      `oct=${planned("2010-10-01")} nov=${planned("2010-11-01")} dec=${planned("2010-12-01")}`,
    );
    assert(
      "RP-29: on 2010-10-20 with 300 of 720 reached, the month line is under pace",
      before.month?.month === "2010-10-01" && before.month.planned === 720 && before.month.reached === 300 &&
        before.month.underPace === true,
      `month = ${JSON.stringify(before.month)}`,
    );
    const early = await loadGoal(goalId, "2010-10-19");
    assert(
      "RP-29: the day before the 20th the same month is not under pace",
      early?.month?.underPace === false,
      `month = ${JSON.stringify(early?.month)}`,
    );
    const zero = await loadGoal(goalId, "2010-11-25");
    assert(
      "RP-29: a month planned at 0 is never under pace",
      zero?.month?.planned === 0 && zero.month.underPace === false,
      `month = ${JSON.stringify(zero?.month)}`,
    );
    assert(
      "RP-28: loadGoal returns the budgets",
      before.budgets.length === 2,
      `budgets = ${JSON.stringify(before.budgets)}`,
    );
    assert(
      "RP-30: a parent and its two children come back in tasks, none done yet",
      before.tasks.length === 3 && before.tasks.filter((task) => task.parentId === parent.id).length === 2 &&
        before.tasks.every((task) => task.doneOn === null),
      `tasks = ${JSON.stringify(before.tasks.map((task) => [task.name, task.parentId === null, task.doneOn]))}`,
    );

    // Written at `now()` on the server's clock, the day is the 2010 one: a
    // read of `done_on` from `written_at` cannot land on it.
    await migrationDb`
      insert into goals.facts (user_id, one_off_id, goal_id, day)
      values (${person.id}, ${done.id}, ${goalId}, '2010-10-10')`;
    // The parent's own fact must add nothing: its leaves already did.
    await migrationDb`
      insert into goals.facts (user_id, one_off_id, goal_id, day)
      values (${person.id}, ${parent.id}, ${goalId}, '2010-10-12')`;
    const after = await loadGoal(goalId, today);
    if (!after) throw new Error("runPlanMonthsCheck: loadGoal returned null after the fact");

    assert(
      "RP-30: a child's done_on is the day of its own fact",
      after.tasks.find((task) => task.id === done.id)?.doneOn === "2010-10-10",
      `doneOn = ${after.tasks.find((task) => task.id === done.id)?.doneOn}`,
    );
    assert(
      "RP-128: a done child's estimate of 60 adds nothing to measureTotal, nor does the parent's 500",
      after.measureTotal - before.measureTotal === 0,
      `before=${before.measureTotal} after=${after.measureTotal}`,
    );
    const weekOf = (view: typeof after) =>
      view.weeks.find((week) => week.startsOn <= "2010-10-10" && "2010-10-10" <= week.endsOn)?.total ?? NaN;
    assert(
      "RP-128: the estimate lands in neither its week nor its month",
      weekOf(after) - weekOf(before) === 0 &&
        (after.months.find((row) => row.month === "2010-10-01")?.reached ?? 0) -
          (before.months.find((row) => row.month === "2010-10-01")?.reached ?? 0) === 0,
      `week ${weekOf(before)} -> ${weekOf(after)}; month ${before.month?.reached} -> ${after.month?.reached}`,
    );
  } finally {
    await migrationDb`delete from goals.goals where id = ${goalId}`;
    await migrationDb.end();
  }
}

/**
 * `/metas` reads the goals and the evidence on two connections at once, never
 * one after the other. A warm call must start the second transaction while
 * the first is held, the way `check-day.ts` asserts it for `loadDay`.
 */
async function runMetasOverlapCheck(): Promise<void> {
  const { listGoalsForMetas } = await import("@/lib/queries/goal");
  await listGoalsForMetas();
  const start = wireCalls.length;
  const { overlap } = await withOverlap(() => listGoalsForMetas());
  const groups = groupByConnection(wireCalls.slice(start));
  assert(
    "listGoalsForMetas' two transactions overlap: the second starts while the first is held (warm)",
    groups.size === 2 && overlap.ok,
    `${groups.size} connection(s), ${overlap.ok ? "overlapped" : overlap.detail}`,
  );
}

/**
 * `loadGoal` and `/metas` read the plan. Goal A (rhythm 600, two
 * plan tasks of 300 and 600, no budget) is the filled case; goal B (no
 * rhythm, tasks fixed in months) is a migrated one; goal C measures nothing.
 * Task rows are backdated through the session pooler: `createdOn` must not
 * sit after the pinned `today`.
 */
async function runPlanRoadmapCheck(): Promise<void> {
  const { createGoal, addCommitment } = await import("@/app/actions/plan");
  const { loadGoal, listGoalsForMetas } = await import("@/lib/queries/goal");
  const { fillPlan } = await import("@/lib/plan/roadmap");
  const { getPerson } = await import("@/lib/session");

  const person = await getPerson();
  if (!person) throw new Error("runPlanRoadmapCheck: no settled session");

  const seeded: string[] = [];
  const open = async (label: string, measured: boolean): Promise<string> => {
    const goal = await createGoal({ name: `check-goal.ts probe — 340 ${label}`, horizon: "2030-01-01" });
    if (!goal.ok) throw new Error(`runPlanRoadmapCheck: createGoal failed: ${goal.error}`);
    seeded.push(goal.goalId);
    if (measured) {
      const commitment = await addCommitment({
        goalId: goal.goalId,
        name: `check-goal.ts probe — 340 ${label} medida`,
        cadenceKind: "daily",
        satisfaction: "quantity",
        targetQuantity: 1,
        unit: "min",
      });
      if (!commitment.ok) throw new Error(`runPlanRoadmapCheck: addCommitment failed: ${commitment.error}`);
    }
    return goal.goalId;
  };

  const migrationDb = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const a = await open("A", true);
    const b = await open("B", true);
    const c = await open("C", false);
    for (const id of [a, b, c]) {
      await migrationDb`
        update goals.goals set created_at = ${new Date("2010-09-15T12:00:00-05:00")}, horizon = '2011-08-15'
        where id = ${id}`;
    }
    await migrationDb`update goals.goals set rhythm = 600 where id = ${a}`;
    const task = async (goalId: string, name: string, estimate: number | null, month: string | null, position: number) => {
      const [row] = await migrationDb<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, estimate, planned_month, in_plan, position, created_at)
        values (${person.id}, ${goalId}, ${`check-goal.ts probe — 340 ${name}`}, ${estimate}, ${month}, true, ${position},
                ${new Date("2010-09-16T12:00:00-05:00")})
        returning id`;
      return row.id;
    };
    const a1 = await task(a, "a1", 300, null, 1);
    const a2 = await task(a, "a2", 600, null, 2);
    const b1 = await task(b, "b1", 120, "2010-10-01", 1);
    const b2 = await task(b, "b2", 90, "2010-11-01", 2);
    const c1 = await task(c, "c1", null, "2010-10-01", 1);
    await task(c, "c2", null, "2010-10-01", 2);
    await migrationDb`
      insert into goals.facts (user_id, one_off_id, goal_id, day) values (${person.id}, ${c1}, ${c}, '2010-10-10')`;

    const today = "2010-10-20";
    const start = wireCalls.length;
    const { result: viewA, overlap } = await withOverlap(() => loadGoal(a, today));
    reportRun("plan-roadmap", wireCalls.slice(start), true, overlap);
    if (!viewA) throw new Error("runPlanRoadmapCheck: loadGoal(A) returned null");

    assert(
      "RP-50: a goal with a rhythm and no budget reads the rhythm as this month's amount",
      viewA.rhythm === 600 && viewA.month?.planned === 600 &&
        viewA.months.find((row) => row.month === "2010-10-01")?.planned === 600,
      `rhythm=${viewA.rhythm} month=${JSON.stringify(viewA.month)}`,
    );
    const expected = fillPlan({
      rhythm: 600,
      budgets: [],
      tasks: [a1, a2].map((id, index) => ({
        id,
        parentId: null,
        name: "",
        plannedMonth: null,
        day: null,
        estimate: index === 0 ? 300 : 600,
        doneOn: null,
        factId: null,
        note: null,
        inPlan: true,
        createdOn: "2010-09-16",
        position: index + 1,
      })),
      openedOn: "2010-09-15",
      horizon: "2011-08-15",
      today,
    });
    const shape = (roadmap: typeof expected) =>
      JSON.stringify([roadmap.state, roadmap.end, roadmap.months.map((m) => [m.month, m.filled, m.items.map((i) => [i.task.id, i.part])])]);
    assert(
      "RP-53: roadmap.end and months match fillPlan over the seeded rows (900 at 600 a month ends in November)",
      expected.state === "planned" && expected.end?.startsWith("2010-11") === true && shape(viewA.roadmap) === shape(expected),
      `got ${shape(viewA.roadmap)}, expected ${shape(expected)}`,
    );
    assert(
      "RP-50: tasks carry in_plan, position and createdOn in the person's zone",
      viewA.tasks.length === 2 && viewA.tasks.every((t) => t.inPlan && t.createdOn === "2010-09-16") &&
        viewA.tasks.find((t) => t.id === a2)?.position === 2,
      `tasks = ${JSON.stringify(viewA.tasks.map((t) => [t.inPlan, t.position, t.createdOn]))}`,
    );

    const metasStart = wireCalls.length;
    const metas = await listGoalsForMetas(today);
    const statements = [...groupByConnection(wireCalls.slice(metasStart)).entries()].reduce(
      (sum, [connection, calls]) => sum + analyzeGroup(connection, calls).applicationCount,
      0,
    );
    const month = (id: string) => metas.open.find((goal) => goal.id === id)?.month;
    assert(
      "/metas: a goal with a rhythm and no budget plans the rhythm this month",
      month(a)?.kind === "amount" && (month(a) as { planned: number | null }).planned === 600,
      `month = ${JSON.stringify(month(a))}`,
    );
    await migrationDb`
      insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${a}, '2010-10-01', 720)`;
    const budgeted = await loadGoal(a, today);
    assert(
      "RP-50: a month's own budget wins over the rhythm",
      budgeted?.month?.planned === 720 && budgeted.months.find((row) => row.month === "2010-11-01")?.planned === 600,
      `month=${JSON.stringify(budgeted?.month)}`,
    );

    const viewB = await loadGoal(b, today);
    const monthItems = (month: string) =>
      viewB?.roadmap.months.find((m) => m.month === month)?.items.map((item) => item.task.id) ?? [];
    assert(
      "a migrated goal (fixed months, no rhythm) reads each task in the month it had",
      viewB?.rhythm === null && JSON.stringify(monthItems("2010-10-01")) === JSON.stringify([b1]) &&
        JSON.stringify(monthItems("2010-11-01")) === JSON.stringify([b2]),
      `oct=${JSON.stringify(monthItems("2010-10-01"))} nov=${JSON.stringify(monthItems("2010-11-01"))}`,
    );

    assert(
      "/metas: a goal with no measure counts the plan's tasks of the month, done and total",
      JSON.stringify(month(c)) === JSON.stringify({ kind: "tasks", month: "2010-10-01", done: 1, total: 2 }),
      `month = ${JSON.stringify(month(c))}`,
    );
    assert(
      "/metas: the statement count is unchanged (four application statements)",
      statements === 4,
      `${statements} application statement(s)`,
    );

    // Goal D: a migrated goal with a task in every position relative to today (2010-10-20).
    const d = await open("D", false);
    await migrationDb`
      update goals.goals set created_at = ${new Date("2010-09-15T12:00:00-05:00")}, horizon = '2011-08-15'
      where id = ${d}`;
    const dPast = await task(d, "dPast", 60, "2010-08-01", 1);
    const dDonePast = await task(d, "dDonePast", 30, "2010-09-01", 2);
    const dNow = await task(d, "dNow", 45, "2010-10-01", 3);
    const dDoneNow = await task(d, "dDoneNow", 15, "2010-10-01", 4);
    const dFuture = await task(d, "dFuture", 90, "2010-12-01", 5);
    await migrationDb`
      insert into goals.facts (user_id, one_off_id, goal_id, day) values
        (${person.id}, ${dDonePast}, ${d}, '2010-09-20'), (${person.id}, ${dDoneNow}, ${d}, '2010-10-10')`;
    const viewD = await loadGoal(d, today);
    const placed = new Map<string, string>();
    for (const m of viewD?.roadmap.months ?? []) {
      for (const item of m.items) {
        placed.set(item.task.id, `${m.month}|done=${item.done}|from=${item.carriedFrom}`);
      }
    }
    const got = (id: string) => placed.get(id) ?? "absent";
    assert(
      "a migrated goal: an undone task of a past month reads in the current month, carried from its own (RP-31)",
      viewD?.rhythm === null && got(dPast) === "2010-10-01|done=false|from=2010-08-01",
      got(dPast),
    );
    assert(
      "a migrated goal: a task of the current month stays there, done or not, never carried",
      got(dNow) === "2010-10-01|done=false|from=null" && got(dDoneNow) === "2010-10-01|done=true|from=null",
      `${got(dNow)} / ${got(dDoneNow)}`,
    );
    assert(
      "a migrated goal: a task of a future month reads in that month",
      got(dFuture) === "2010-12-01|done=false|from=null" && viewD?.roadmap.unplaced.length === 0,
      `${got(dFuture)} unplaced=${viewD?.roadmap.unplaced.length}`,
    );
    assert(
      "a migrated goal: a task done in a past month is not listed in the current one",
      got(dDonePast) === "absent",
      got(dDonePast),
    );
    const metasD = await listGoalsForMetas(today);
    assert(
      "/metas: a migrated goal's month line counts the carried and the current month's tasks, done and total",
      JSON.stringify(metasD.open.find((goal) => goal.id === d)?.month) ===
        JSON.stringify({ kind: "tasks", month: "2010-10-01", done: 1, total: 3 }),
      JSON.stringify(metasD.open.find((goal) => goal.id === d)?.month),
    );
  } finally {
    for (const id of seeded) await migrationDb`delete from goals.goals where id = ${id}`;
    await migrationDb.end();
  }
}

// RP-74: «Reto de lectura», 16 September to 7 October 2026 at 600 a month,
// plans 300 in September and 135 in October in `loadGoal` and in /metas.
async function runSharedMonthsCheck(): Promise<void> {
  const { createGoal, addCommitment } = await import("@/app/actions/plan");
  const { loadGoal, listGoalsForMetas } = await import("@/lib/queries/goal");

  const goal = await createGoal({ name: "check-goal.ts probe — 825 Reto", horizon: "2030-01-01" });
  if (!goal.ok) throw new Error(`runSharedMonthsCheck: createGoal failed: ${goal.error}`);
  const migrationDb = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const commitment = await addCommitment({
      goalId: goal.goalId,
      name: "check-goal.ts probe — 825 Reto medida",
      cadenceKind: "daily",
      satisfaction: "quantity",
      targetQuantity: 1,
      unit: "min",
    });
    if (!commitment.ok) throw new Error(`runSharedMonthsCheck: addCommitment failed: ${commitment.error}`);
    await migrationDb`
      update goals.goals set created_at = ${new Date("2026-09-16T12:00:00-05:00")}, horizon = '2026-10-08', rhythm = 600
      where id = ${goal.goalId}`;

    const view = await loadGoal(goal.goalId, "2026-10-07");
    assert(
      "RP-74: the goal's months plan the share of the rhythm its days take, 300 and 135",
      JSON.stringify(view?.months.map((row) => row.planned)) === "[300,135]" && view?.month?.planned === 135,
      `months=${JSON.stringify(view?.months.map((row) => [row.month, row.planned]))} month=${JSON.stringify(view?.month)}`,
    );
    const metas = async (today: string) =>
      (await listGoalsForMetas(today)).open.find((entry) => entry.id === goal.goalId)?.month as { planned?: number | null } | null | undefined;
    const first = await metas("2026-09-20");
    const last = await metas("2026-10-07");
    assert(
      "RP-74: /metas plans the share in the first month and in the last",
      first?.planned === 300 && last?.planned === 135,
      `first=${JSON.stringify(first)} last=${JSON.stringify(last)}`,
    );
  } finally {
    await migrationDb`delete from goals.goals where id = ${goal.goalId}`;
    await migrationDb.end();
  }
}

async function runMain(): Promise<void> {
  installStubs(loadCookies(), "none");

  const { loadGoal } = await import("@/lib/queries/goal");

  const goalId = await seedMixedMeasureGoal();
  console.log(`seeded goal ${goalId}`);

  // First call: whatever the pool's connections happen to be, cold after
  // this process's own startup. Its bracket, its type-fetch cap, its
  // statement count, its overlap and its reading bounds are asserted like
  // any other run: the barrier holds the first transaction before any dial.
  const coldStart = wireCalls.length;
  const { result: cold, overlap: coldOverlap } = await withOverlap(() => loadGoal(goalId));
  const coldCalls = wireCalls.slice(coldStart);
  reportRun("cold", coldCalls, false, coldOverlap);
  await assertBoundsResolveToGoalRow(goalId, coldCalls);
  if (!cold) throw new Error(`runMain: loadGoal(${goalId}) returned null on the cold call — the seeded goal is gone`);

  // Five consecutive warm calls, each bounded on its own — the same number
  // `check-day.ts` settled on: a fix that only holds for the first couple of
  // warm calls is a fix a later screen the same minute would still be
  // paying for.
  const WARM_CALLS = 5;
  const warmResults: NonNullable<Awaited<ReturnType<typeof loadGoal>>>[] = [];
  for (let i = 1; i <= WARM_CALLS; i++) {
    const start = wireCalls.length;
    const { result, overlap } = await withOverlap(() => loadGoal(goalId));
    reportRun(`warm-${i}`, wireCalls.slice(start), true, overlap);
    if (!result) throw new Error(`runMain: loadGoal(${goalId}) returned null on warm-${i} — the seeded goal is gone`);
    warmResults.push(result);
    assert(`the warm-${i} run reads the source`, result.evidence === "read", `evidence = ${result.evidence}`);
  }

  const coldCommitmentIds = cold.commitments.map((commitment) => commitment.id).sort();
  const warmCommitmentIdLists = warmResults.map((result) => result.commitments.map((commitment) => commitment.id).sort());
  assert(
    "the cold and every warm run declare the same commitments",
    warmCommitmentIdLists.every((ids) => JSON.stringify(ids) === JSON.stringify(coldCommitmentIds)),
    `cold ${coldCommitmentIds.length} commitment(s); warm ${warmCommitmentIdLists.map((ids) => ids.length).join(", ")} commitment(s)`,
  );

  assert(
    "against the real (empty) reading.lookups, the goal sums to its declared total alone, not zero and not undefined",
    cold.measureTotal === DECLARED_QUANTITY && warmResults.every((result) => result.measureTotal === DECLARED_QUANTITY),
    `expected ${DECLARED_QUANTITY}, cold=${cold.measureTotal} warm=[${warmResults.map((result) => result.measureTotal).join(", ")}]`,
  );
  assert(
    "the goal's own measure unit is the evidence source's own unit",
    cold.measureUnit === "searches",
    `measureUnit = ${cold.measureUnit}`,
  );

  // The registry's reader replaced in a child process (dispatched there):
  // proves the sum against known rows, since no harness identity on this database carries a real `reading.lookups` row to sum instead.
  const stubExpected = DECLARED_QUANTITY + STUB_TOTAL;
  const stub = runChildProcess("stub", goalId);
  console.log(`\nstub run — evidence = ${stub.evidence}, measureTotal = ${stub.measureTotal}`);
  assert("the stub run reads the source", stub.evidence === "read", `evidence = ${stub.evidence}`);
  assert(
    "a goal measured by both a declared fact and an evidence commitment sums the two, not either alone",
    stub.measureTotal === stubExpected,
    `expected ${stubExpected} (${DECLARED_QUANTITY} declared + ${STUB_TOTAL} evidence: ${STUB_QUANTITIES.join("+")}), got ${stub.measureTotal}`,
  );

  const degraded = runChildProcess("degraded", goalId);
  console.log(`\ndegraded run — evidence = ${degraded.evidence}, measureTotal = ${degraded.measureTotal}`);
  assert(
    "the degraded run reports the source unreadable, never throws",
    degraded.evidence === "unreadable",
    `evidence = ${degraded.evidence}`,
  );
  assert(
    "the degraded run still returns the goal, with its declared total alone, never zeroed by the source's own failure",
    degraded.measureTotal === DECLARED_QUANTITY,
    `expected ${DECLARED_QUANTITY} (the declared fact alone), got ${degraded.measureTotal}`,
  );

  await runMeasureRenameCheck();
  await runPhaseOverlapRaceCheck();
  await runWeeksCheck();
  await runLateNightOpenCheck();
  await runEndedCheck();
  await runPlanMonthsCheck();
  await runMetasOverlapCheck();
  await runPlanRoadmapCheck();

  // The commitment that reads a source names it, by the catalogue's own label
  // key; one that reads nothing names none.
  const catalogue = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const [source] = await catalogue<{ label_key: string }[]>`
    select label_key from goals.evidence_sources where key = 'reading_lookups'`;
  await catalogue.end();
  const byKind = (kind: "evidence" | "quantity") => cold.commitments.filter((c) => c.satisfiedBy.kind === kind);
  assert(
    "a commitment satisfied by evidence carries its source's label key",
    byKind("evidence").length > 0 && byKind("evidence").every((c) => c.sourceLabelKey === source.label_key),
    `evidence: ${JSON.stringify(byKind("evidence").map((c) => c.sourceLabelKey))}, catalogue says ${source.label_key}`,
  );
  assert(
    "a commitment that reads no source carries no label key",
    byKind("quantity").length > 0 && byKind("quantity").every((c) => c.sourceLabelKey === null),
    `quantity: ${JSON.stringify(byKind("quantity").map((c) => c.sourceLabelKey))}`,
  );

  await runCommitmentUnitCheck();
  await runSharedMonthsCheck();
  await runEndlessGoalCheck();

  console.log("");
  console.log(failed ? "REPORT  failed" : "REPORT  passed");
  process.exit(failed ? 1 : 0);
}

// RP-99: a goal with no end is open for good on /metas and its own screen, never ended.
async function runEndlessGoalCheck(): Promise<void> {
  const { loadGoal, listGoalsForMetas, listGoals } = await import("@/lib/queries/goal");
  const { getPerson } = await import("@/lib/session");

  const person = await getPerson();
  if (!person) throw new Error("runEndlessGoalCheck: no verified session");
  const migrationDb = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  let goalId: string | null = null;
  try {
    const [goal] = await migrationDb<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, 'check-goal.ts probe — 913 sin final', null, '2026-08-10T12:00:00-05:00'::timestamptz)
      returning id
    `;
    goalId = goal.id;
    const metas = await listGoalsForMetas("2026-10-13");
    assert(
      "913: /metas lists a goal with no end open and never ended",
      metas.open.some((g) => g.id === goalId) && !metas.ended.some((g) => g.id === goalId),
      `open=${metas.open.length} ended=${metas.ended.length}`,
    );
    const view = await loadGoal(goalId, "2026-10-13");
    assert(
      "913: its screen has no end day and its months reach eleven past October, 2027-09",
      view?.endedOn === null && view.months[0]?.month === "2026-08-01" && view.months.at(-1)?.month === "2027-09-01",
      `endedOn=${view?.endedOn} months=${JSON.stringify(view?.months.map((m) => m.month))}`,
    );
    assert("913: the rail lists it", (await listGoals()).some((g) => g.id === goalId), "missing from listGoals");
  } finally {
    if (goalId) await migrationDb`delete from goals.goals where id = ${goalId}`;
    await migrationDb.end();
  }
}

void (async () => {
  try {
    assertSuiteDatabase();
    const childArg = process.argv.find((arg) => arg.startsWith("--child="));
    const goalArg = process.argv.find((arg) => arg.startsWith("--goal="));
    if (childArg) {
      const mode = childArg.slice("--child=".length) as "stub" | "degraded";
      const goalId = goalArg?.slice("--goal=".length);
      if (!goalId) throw new Error("--child needs --goal=<id>");
      await runChild(mode, goalId);
      // `failed` is this process's own — a fresh process per run, so this
      // reads only what `reportChildRun` just asserted, nothing carried
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
