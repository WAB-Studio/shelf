// Takes the identities every path that predates registration left behind — 59
// orphans with a null `created_at` and 7 with a null email, the residue of the
// heuristic cleanup `private/reportes/defecto-d8.md` §«Incidente propio» refused
// to write — and hands them to the registry the same way a live run would have,
// so `harness:reap` can take them by the one rule it already trusts.
//
// This command PROVES NOTHING BY EMAIL. The proof is the sentence modules 3, 5,
// 6, 7 and 8 make true: every path that still creates an identity registers it
// in the same statement, so an `auth.users` row with no `harness.identities` row
// cannot belong to any run, live or dead — it can only be older than the
// registry itself. The email pattern below is a candidate filter, narrower than
// `harness:census`'s on purpose: it matches the exact shape `createUser()`
// (`scripts/harness/fixtures.ts`) has always minted, `harness-<uuid>@…`, never
// the broader `harness%@…` a lane's own shared identity also matches. Widening
// it, or adding a `created_at` window, reopens the guess this file exists to
// close.
//
// It deletes nothing. It inserts a synthetic run and one `harness.identities`
// row per candidate, then stops — the same 30-minute quarantine `harness:reap`
// already gives a killed run's identities. If a process the census could not
// see is still writing under one of these ids, it is still writing 30 minutes
// from now, and a second `harness:census` shows it. Only after that window does
// `harness:reap --yes` remove them, by the dead-run rule it already applies to
// everything else.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { fixtureSql } from "./fixtures";

type LiveRun = {
  id: string;
  lane: number;
  suite: string;
  host: string;
  pid: number;
  heartbeat_at: Date;
};

type Candidate = { id: string; email: string | null };

// The email `harness-<uuid>@example.invalid` `createUser()` has always minted,
// anchored on the eight leading hex digits of the uuid so it can never match a
// lane's own shared address (`harness@…`, `harness-2@…`, `harness-member-2@…`)
// — none of those put eight hex digits and a hyphen straight after `harness-`.
const SYNTHETIC_UUID_EMAIL = "^harness-[0-9a-f]{8}-";

// Every table `owner_user_id` names, mirrored from `scripts/harness/census.ts`
// rather than imported: that file exports nothing, and this module reads no
// state of its own — duplicating the list costs one place to update, the same
// trade `scripts/harness/fixtures.ts`'s `laneSharedEmail` already takes against
// `session.ts`.
const OWNER_TABLES = [
  "ingest_deliveries",
  "ingest_shapes",
  "ingest_merchants",
  "savings_goals",
  "budgets",
  "planned_payments",
  "recurring_rules",
  "webhook_credentials",
  "labels",
  "categories",
  "accounts",
  "transactions",
] as const;

// Mirrors `@repo/harness-registry`'s private `harnessLane`, not imported:
// that function is module-scoped there for the same reason `session.ts`'s
// `laneSuffix` is — no file in this pair imports the other's internals.
function harnessLane(): number {
  const raw = process.env.HARNESS_LANE?.trim();
  if (!raw) return 1;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`HARNESS_LANE must be a positive integer, not "${raw}"`);
  }

  return Number(raw);
}

// Mirrors `@repo/harness-registry`'s private `currentGitBranch`: a
// debugging aid on the run row, not a fact anything here depends on.
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

/**
 * The only interlock, modelled on `scripts/harness/reap.ts`'s `liveRuns`: the
 * registry is the sole predicate. `pg_stat_activity` cannot serve as one —
 * Supabase's pooler overwrites `application_name` to `Supavisor` on both
 * endpoints (`docs/TRAPS.md` §«Supavisor overwrites `application_name`») — so a
 * check built on it would never fire.
 */
async function liveRuns(): Promise<LiveRun[]> {
  return fixtureSql<LiveRun[]>`
    select id, lane, suite, host, pid, heartbeat_at
    from harness.runs
    where finished_at is null and heartbeat_at > now() - interval '30 minutes'
    order by heartbeat_at
  `;
}

function describe(run: LiveRun): string {
  const seconds = Math.max(0, Math.round((Date.now() - run.heartbeat_at.getTime()) / 1000));
  const age = seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${(seconds / 3600).toFixed(1)}h`;
  return `lane ${run.lane}  ${run.suite}  ${run.host}:${run.pid}  heartbeat ${age} ago  (${run.id})`;
}

// `auth.users` rows the registry never saw: no `harness.identities` row names
// them, and their email is either the synthetic uuid shape or absent — the
// ad-hoc probes `private/planes/plan-datos-de-prueba.md` measures at 7.
async function candidates(): Promise<Candidate[]> {
  return fixtureSql<Candidate[]>`
    select u.id, u.email
    from auth.users u
    where (u.email ~ ${SYNTHETIC_UUID_EMAIL} or u.email is null)
      and not exists (select 1 from harness.identities hi where hi.user_id = u.id)
    order by u.email nulls first
  `;
}

// One candidate's footprint, across every `owner_user_id` table plus
// `group_members` (keyed by `user_id`). Run once per candidate rather than
// pooled into one statement, same way `harness:census` reports the database's
// weight: this is the report, not the register — the register happens once,
// below, after every candidate's line has printed.
async function ownershipFor(candidateId: string): Promise<string[]> {
  const unionSql = OWNER_TABLES.map(
    (table) => `select owner_user_id, '${table}' as table_name from ${table}`,
  ).join(" union all ");

  const rows = await fixtureSql.unsafe<{ table_name: string; n: number }[]>(
    `select table_name, count(*)::int as n
     from (
       ${unionSql}
       union all
       select user_id as owner_user_id, 'group_members' as table_name from group_members
     ) owned
     where owner_user_id = $1
     group by table_name
     order by table_name`,
    [candidateId],
  );

  return rows.map((row) => `${row.table_name}=${row.n}`);
}

/**
 * One statement: a synthetic `harness.runs` row, `suite = 'adopt'`, and one
 * `harness.identities` row per candidate under it, all `ephemeral`. Left
 * `finished_at` null and its heartbeat never touched again once this process
 * exits, so `harness:reap` finds it dead the moment its heartbeat crosses the
 * same 30-minute line every other dead run is judged against.
 *
 * `harness.identities.email` is `not null`; a candidate with no address in
 * `auth.users` still needs one here, so a missing email is named as the fact
 * it is, `(no email) <id>`, never invented as a fake address.
 */
async function adopt(found: Candidate[]): Promise<string> {
  const runId = randomUUID();
  const ids = found.map((c) => c.id);
  const emails = found.map((c) => c.email ?? `(no email) ${c.id}`);

  await fixtureSql.unsafe(
    `with new_run as (
       insert into harness.runs (id, lane, suite, host, pid, git_branch)
       values ($1, $2, 'adopt', $3, $4, $5)
       returning id
     )
     insert into harness.identities (user_id, run_id, email, disposition)
     select c.id, new_run.id, c.email, 'ephemeral'
     from new_run, unnest($6::uuid[], $7::text[]) as c(id, email)`,
    [runId, harnessLane(), hostname(), process.pid, currentGitBranch(), ids, emails],
  );

  return runId;
}

async function main(): Promise<void> {
  let trips = 0;
  const run = async <T>(query: Promise<T>): Promise<T> => {
    trips += 1;
    return query;
  };

  const blocking = await run(liveRuns());
  if (blocking.length > 0) {
    console.error("BLOCKED  a live run holds harness.runs — refusing to start:");
    for (const r of blocking) console.error(`  ${describe(r)}`);
    console.log(`\nREPORT  adopt — ${trips} round trip(s), nothing touched.`);
    process.exit(1);
  }

  const found = await run(candidates());
  if (found.length === 0) {
    console.log("nothing to adopt — no auth.users row matches the shape and lacks a registry row");
    console.log(`\nREPORT  adopt — ${trips} round trip(s), nothing adopted.`);
    process.exit(0);
  }

  console.log(`${found.length} candidate(s):`);
  for (const c of found) {
    const owns = await run(ownershipFor(c.id));
    console.log(`  ${c.id}  ${c.email ?? "(null email)"}  ${owns.length > 0 ? owns.join(", ") : "(owns nothing)"}`);
  }

  const runId = await run(adopt(found));

  console.log(
    `\nREPORT  adopt — registered ${found.length} identity(ies) under run ${runId}, ${trips} round trip(s). Deleted nothing — quarantined 30 minutes, then \`harness:reap --yes\`.`,
  );
}

void (async () => {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    console.error(`FAILED  ${(error as Error).message}`);
    process.exit(1);
  } finally {
    await fixtureSql.end();
  }
})();
