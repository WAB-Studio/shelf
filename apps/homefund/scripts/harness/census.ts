// What the harness holds, read-only. Writes nothing — `scripts/harness/reap.ts`
// is the only command in this pair that deletes, and it reads its own plan
// straight off `harness.runs`/`harness.identities`, never off this script's
// output. Run this before and after a session (`docs/agentes/verificacion.md` § Harness accounting):
// the two numbers are the session's footprint.
import { fixtureSql } from "./fixtures";

// Every table `owner_user_id` names, in the order `purgeIdentity`
// (`scripts/harness/fixtures.ts`) deletes them — read here, never written.
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

function heartbeatAge(heartbeatAt: Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - heartbeatAt.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

async function main(): Promise<void> {
  let trips = 0;
  const run = async <T>(query: Promise<T>): Promise<T> => {
    trips += 1;
    return query;
  };

  console.log("== live runs (finished_at is null) ==");
  const liveRuns = await run(fixtureSql<
    { id: string; lane: number; suite: string; host: string; pid: number; heartbeat_at: Date }[]
  >`
    select id, lane, suite, host, pid, heartbeat_at
    from harness.runs
    where finished_at is null
    order by heartbeat_at
  `);
  if (liveRuns.length === 0) console.log("(none)");
  for (const r of liveRuns) {
    console.log(
      `  lane ${r.lane}  ${r.suite}  ${r.host}:${r.pid}  heartbeat ${heartbeatAge(r.heartbeat_at)} ago  (${r.id})`,
    );
  }

  console.log("\n== registered identities, by disposition ==");
  const dispositions = await run(fixtureSql<{ disposition: string; n: number }[]>`
    select disposition, count(*)::int as n from harness.identities group by disposition order by disposition
  `);
  if (dispositions.length === 0) console.log("(none)");
  for (const d of dispositions) console.log(`  ${d.disposition}: ${d.n}`);

  console.log("\n== unregistered harness%@example.invalid / null-email auth.users rows ==");
  const unregistered = await run(fixtureSql<{ id: string; email: string | null }[]>`
    select u.id, u.email
    from auth.users u
    where (u.email like 'harness%@example.invalid' or u.email is null)
      and not exists (select 1 from harness.identities hi where hi.user_id = u.id)
    order by u.email nulls first
  `);
  console.log(`  ${unregistered.length} candidate(s) — no harness.identities row names any of them`);

  const ownedByCandidate = new Map<string, string[]>();
  if (unregistered.length > 0) {
    const candidateIds = unregistered.map((u) => u.id);
    // One statement across every `owner_user_id` table plus `group_members`
    // (keyed by `user_id`, not `owner_user_id`), so this stays one round trip
    // no matter how many candidates the census is naming. Table names are the
    // constant list above, never a caller value, so building the union by
    // string join reaches no injection surface — only `candidateIds` crosses
    // the wire as a parameter.
    const unionSql = OWNER_TABLES.map(
      (table) => `select owner_user_id, '${table}' as table_name from ${table}`,
    ).join(" union all ");
    const owned = await run(
      fixtureSql.unsafe<{ user_id: string; table_name: string; n: number }[]>(
        `select owner_user_id as user_id, table_name, count(*)::int as n
         from (
           ${unionSql}
           union all
           select user_id as owner_user_id, 'group_members' as table_name from group_members
         ) owned
         where owner_user_id = any($1::uuid[])
         group by owner_user_id, table_name
         order by owner_user_id, table_name`,
        [candidateIds],
      ),
    );
    for (const row of owned) {
      const list = ownedByCandidate.get(row.user_id);
      const entry = `${row.table_name}=${row.n}`;
      if (list) list.push(entry);
      else ownedByCandidate.set(row.user_id, [entry]);
    }
  }
  for (const u of unregistered) {
    const owns = ownedByCandidate.get(u.id);
    console.log(`  ${u.id}  ${u.email ?? "(null email)"}  ${owns ? owns.join(", ") : "(owns nothing)"}`);
  }

  console.log("\n== audit_log, four ways ==");
  const auditSplit = await run(fixtureSql<{ bucket: string; n: number }[]>`
    select
      case
        when owner_user_id is not null then 'owned'
        when actor_user_id is not null then 'actor-only'
        when action = 'DELETE' then 'both-null-delete'
        else 'both-null-other'
      end as bucket,
      count(*)::int as n
    from audit_log
    group by bucket
    order by bucket
  `);
  for (const bucket of ["owned", "actor-only", "both-null-delete", "both-null-other"]) {
    const found = auditSplit.find((b) => b.bucket === bucket);
    console.log(`  ${bucket}: ${found?.n ?? 0}`);
  }

  console.log("\n== auth.refresh_tokens / auth.sessions, per harness identity ==");
  const identities = await run(fixtureSql<{ user_id: string; email: string }[]>`
    select user_id, email from harness.identities order by email
  `);
  let refreshCounts: { user_id: string; n: number }[] = [];
  let sessionCounts: { user_id: string; n: number }[] = [];
  if (identities.length > 0) {
    const ids = identities.map((i) => i.user_id);
    refreshCounts = await run(fixtureSql<{ user_id: string; n: number }[]>`
      select user_id, count(*)::int as n from auth.refresh_tokens
      where user_id in ${fixtureSql(ids)}
      group by user_id
    `);
    sessionCounts = await run(fixtureSql<{ user_id: string; n: number }[]>`
      select user_id::text as user_id, count(*)::int as n from auth.sessions
      where user_id in ${fixtureSql(ids)}
      group by user_id
    `);
  }
  for (const identity of identities) {
    const refresh = refreshCounts.find((r) => r.user_id === identity.user_id)?.n ?? 0;
    const sessions = sessionCounts.find((s) => s.user_id === identity.user_id)?.n ?? 0;
    if (refresh === 0 && sessions === 0) continue;
    console.log(`  ${identity.email}  refresh_tokens=${refresh}  sessions=${sessions}`);
  }

  console.log("\n== database size ==");
  // `access_tokens` carries no `client_id`: a client reaches a token only through
  // an `oauth_codes` or `oauth_refresh` row, so "no owner" is no code and no
  // refresh. `query_to_xml` defers parsing the count to run time, so a database
  // with no `goals` schema answers null in the same trip instead of failing.
  const [{ size, orphans }] = await run(fixtureSql<{ size: string; orphans: number | null }[]>`
    select pg_size_pretty(pg_database_size(current_database())) as size, case
      when to_regclass('goals.oauth_clients') is null
        or to_regclass('goals.oauth_codes') is null
        or to_regclass('goals.oauth_refresh') is null then null
      else (xpath('/row/n/text()', query_to_xml(
        'select count(*) as n from goals.oauth_clients c
         where not exists (select 1 from goals.oauth_codes oc where oc.client_id = c.id)
           and not exists (select 1 from goals.oauth_refresh orf where orf.client_id = c.id)',
        false, true, '')))[1]::text::int
    end as orphans
  `);
  console.log(`  ${size}`);

  console.log("\n== goals.oauth_clients ==");
  console.log(orphans === null ? "  oauth_clients sin dueño: no hay esquema goals" : `  oauth_clients sin dueño: ${orphans}`);

  console.log(`\nREPORT  census — ${trips} round trips.`);
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
