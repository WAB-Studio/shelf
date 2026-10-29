// Deletes what a provably dead run left. The registry is the only predicate —
// no email pattern, no name prefix, no `created_at` window — because that
// pattern already cost this database 59 orphan identities with a null
// `created_at` that nothing can now name (`private/planes/plan-datos-de-prueba.md`).
// A shared identity is never a candidate: it hangs off no run
// (`harness_identities_run_matches_disposition`), so step 2 below can never
// select one.
import { fixtureSql, purgeAuditTrail, purgeIdentity } from "./fixtures";

type DeadRun = { id: string; lane: number; suite: string; host: string; pid: number; heartbeat_at: Date };
type Identity = { run_id: string; user_id: string; email: string };
type OAuthClient = { run_id: string; client_id: string };

/**
 * The only interlock. `pg_stat_activity` cannot serve as one — Supabase's
 * pooler overwrites `application_name` to `Supavisor` on both endpoints
 * (`docs/TRAPS.md` §«Supavisor overwrites `application_name`»), so a check
 * built on it would never fire. This one reads the same row the reaper's own
 * dead-run predicate reads, just the other side of the 30-minute line.
 */
async function liveRuns(): Promise<DeadRun[]> {
  return fixtureSql<DeadRun[]>`
    select id, lane, suite, host, pid, heartbeat_at
    from harness.runs
    where finished_at is null and heartbeat_at > now() - interval '30 minutes'
    order by heartbeat_at
  `;
}

async function deadRuns(): Promise<DeadRun[]> {
  return fixtureSql<DeadRun[]>`
    select id, lane, suite, host, pid, heartbeat_at
    from harness.runs
    where finished_at is null and heartbeat_at < now() - interval '30 minutes'
    order by heartbeat_at
  `;
}

// Finished runs over a week old. A clean close leaves none of them holding a
// client; one that leaked a client still loses it here.
async function staleFinishedRuns(): Promise<{ id: string }[]> {
  return fixtureSql<{ id: string }[]>`
    select id from harness.runs
    where finished_at is not null and finished_at < now() - interval '7 days'
  `;
}

async function ephemeralIdentitiesUnder(runIds: string[]): Promise<Identity[]> {
  if (runIds.length === 0) return [];
  return fixtureSql<Identity[]>`
    select run_id, user_id, email
    from harness.identities
    where run_id in ${fixtureSql(runIds)} and disposition = 'ephemeral'
  `;
}

async function oauthClientsUnder(runIds: string[]): Promise<OAuthClient[]> {
  if (runIds.length === 0) return [];
  return fixtureSql<OAuthClient[]>`
    select run_id, client_id from harness.oauth_clients where run_id in ${fixtureSql(runIds)}
  `;
}

function describe(run: DeadRun): string {
  const seconds = Math.max(0, Math.round((Date.now() - run.heartbeat_at.getTime()) / 1000));
  const age = seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${(seconds / 3600).toFixed(1)}h`;
  return `lane ${run.lane}  ${run.suite}  ${run.host}:${run.pid}  heartbeat ${age} ago  (${run.id})`;
}

async function main(): Promise<void> {
  const dryRun = !process.argv.includes("--yes");
  let trips = 0;
  const run = async <T>(query: Promise<T>): Promise<T> => {
    trips += 1;
    return query;
  };

  const blocking = await run(liveRuns());
  if (blocking.length > 0) {
    console.error("BLOCKED  a live run holds harness.runs — refusing to start:");
    for (const r of blocking) console.error(`  ${describe(r)}`);
    console.log(`\nREPORT  reap — ${trips} round trip(s), nothing touched.`);
    process.exit(1);
  }

  // In series, never `Promise.all`: two parameterless statements queued on this
  // one pooled connection never answer on the remote (`docs/TRAPS.md`).
  const dead = await run(deadRuns());
  const stale = await run(staleFinishedRuns());
  if (dead.length === 0 && stale.length === 0) {
    console.log(
      "nothing dead — no harness.runs row is finished_at null with a stale heartbeat, none finished over 7 days ago",
    );
    console.log(`\nREPORT  reap — ${trips} round trip(s), nothing deleted.`);
    process.exit(0);
  }

  const deadIds = dead.map((r) => r.id);
  const staleIds = stale.map((r) => r.id);
  const identities = await run(ephemeralIdentitiesUnder(deadIds));
  const clients = await run(oauthClientsUnder([...deadIds, ...staleIds]));

  console.log(`${dryRun ? "PLAN" : "REAPING"}  ${dead.length} dead run(s):`);
  for (const r of dead) {
    const owned = identities.filter((i) => i.run_id === r.id);
    const ownedClients = clients.filter((c) => c.run_id === r.id);
    console.log(
      `  ${describe(r)} — ${owned.length} ephemeral identity(ies), ${ownedClients.length} OAuth client(s)`,
    );
    for (const i of owned) console.log(`    ${i.email} (${i.user_id})`);
    for (const c of ownedClients) console.log(`    oauth client ${c.client_id}`);
  }
  console.log(`${dryRun ? "PLAN" : "REAPING"}  ${stale.length} run(s) finished over 7 days ago:`);
  // Only the ones still holding a client: a week of clean runs is thousands of rows.
  for (const id of staleIds) {
    const ownedClients = clients.filter((c) => c.run_id === id);
    if (ownedClients.length === 0) continue;
    console.log(`  ${id} — ${ownedClients.length} OAuth client(s)`);
    for (const c of ownedClients) console.log(`    oauth client ${c.client_id}`);
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing deleted. Pass --yes to reap.");
    console.log(`\nREPORT  reap — ${trips} round trip(s), nothing deleted.`);
    process.exit(0);
  }

  // One identity's undeletable row (L1, `fixtures.ts`) no longer costs its
  // whole run: everything else still comes down, and the run that owns the
  // failure is left dead and visible for the next census instead of half-reaped.
  const purgedByRun = new Map<string, string[]>();
  const failed: string[] = [];
  for (const identity of identities) {
    try {
      await purgeIdentity(identity.user_id);
      trips += 23;
      await purgeAuditTrail([identity.user_id]);
      trips += 1;
      const list = purgedByRun.get(identity.run_id);
      if (list) list.push(identity.user_id);
      else purgedByRun.set(identity.run_id, [identity.user_id]);
    } catch (error) {
      console.error(
        `reap: identity ${identity.user_id} (${identity.email}) did not drop — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      failed.push(identity.run_id);
    }
  }

  const purgedIds = [...purgedByRun.values()].flat();
  if (purgedIds.length > 0) {
    await run(fixtureSql`delete from harness.identities where user_id in ${fixtureSql(purgedIds)}`);
  }

  // `goals.oauth_codes` and `goals.oauth_refresh` cascade from their client.
  // The registry rows go only once their clients are gone, so a failed delete
  // leaves the trail for the next reap.
  const clientIds = clients.map((c) => c.client_id);
  let droppedClients = 0;
  if (clientIds.length > 0) {
    try {
      await run(fixtureSql`delete from goals.oauth_clients where id in ${fixtureSql(clientIds)}`);
      await run(fixtureSql`delete from harness.oauth_clients where client_id in ${fixtureSql(clientIds)}`);
      droppedClients = clientIds.length;
    } catch (error) {
      console.error(
        `reap: ${clientIds.length} OAuth client(s) did not drop — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      failed.push(...new Set(clients.map((c) => c.run_id)));
    }
  }

  // A run named in `failed` kept at least one identity or OAuth client — its
  // registry row still names it, so the run row stays too: deleting it would
  // cut the trail the next census needs to find the leak again.
  const clearRunIds = deadIds.filter((id) => !failed.includes(id));
  if (clearRunIds.length > 0) {
    await run(fixtureSql`delete from harness.runs where id in ${fixtureSql(clearRunIds)}`);
  }

  const clearStaleIds = staleIds.filter((id) => !failed.includes(id));
  if (clearStaleIds.length > 0) {
    await run(fixtureSql`delete from harness.runs where id in ${fixtureSql(clearStaleIds)}`);
  }

  console.log(
    `\nREPORT  reap — dropped ${purgedIds.length} identity(ies), ${droppedClients} OAuth client(s), ${clearRunIds.length} dead run(s), ${clearStaleIds.length} stale finished run(s), ${trips} round trip(s).`,
  );

  if (failed.length > 0) {
    console.error(`reap: ${failed.length} run(s) still hold an identity or an OAuth client nothing here could drop.`);
    process.exit(1);
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
    await fixtureSql.end();
  }
})();
