// The browser suite's one run. Playwright calls the default export once in its
// runner process, before any spec, and the function it returns once after the
// last: the same process opens the run, beats it for the suite's whole life,
// drops every identity registered under it and stamps `finished_at`. A runner
// killed mid-suite never reaches the teardown, so its run goes stale and
// `harness:reap` takes it — never this file, and never by aging a column.
//
// Every child minted under this run learns its id from `HARNESS_RUN_ID`:
// set here before the workers fork, so a spec's own `mint-session.ts` child
// inherits it through `process.env`.
import { execFileSync } from "node:child_process";

import {
  assertSuiteDatabase,
  closeRun,
  openRun,
  registeredIdentities,
  registeredOAuthClients,
} from "@repo/harness-registry";
import postgres from "postgres";

export function runScript(script: string, runId: string): void {
  execFileSync(
    process.execPath,
    ["--import", "tsx", "--env-file=.env.local", script],
    { env: { ...process.env, HARNESS_RUN_ID: runId }, stdio: "inherit" },
  );
}

/**
 * Drops every ephemeral identity this run registered, each in its own `try`,
 * then its registry rows, then the run's OAuth clients and theirs. `closeRun`
 * only when all of them dropped: a run that
 * stamps `finished_at` over a leak hides it from the reaper for good
 * (`docs/TRAPS.md`, "A run that leaked must not stamp `finished_at`").
 */
export async function dropRun(sql: postgres.Sql): Promise<void> {
  const failed: string[] = [];
  try {
    const ids = await registeredIdentities(sql, "ephemeral");
    const dropped: string[] = [];

    for (const id of ids) {
      try {
        // Every `goals.*` row cascades from `auth.users`; a pulsar person has
        // no `app_users` row and writes no `audit_log` row.
        await sql`delete from auth.users where id = ${id}`;
        dropped.push(id);
      } catch (error) {
        console.error(
          `e2e-run: identity ${id} did not drop — ${error instanceof Error ? error.message : String(error)}`,
        );
        failed.push(id);
      }
    }

    if (dropped.length > 0) {
      // No foreign key ties this row to `auth.users`, so it outlives the
      // identity it names until dropped here.
      await sql`delete from harness.identities where user_id in ${sql(dropped)}`;
    }

    // `oauth_codes` and `oauth_refresh` cascade from their client.
    let clients = 0;
    try {
      const clientIds = await registeredOAuthClients(sql);
      if (clientIds.length > 0) {
        await sql`delete from goals.oauth_clients where id in ${sql(clientIds)}`;
        await sql`delete from harness.oauth_clients where client_id in ${sql(clientIds)}`;
      }
      clients = clientIds.length;
    } catch (error) {
      console.error(
        `e2e-run: OAuth clients did not drop — ${error instanceof Error ? error.message : String(error)}`,
      );
      failed.push("oauth_clients");
    }

    if (failed.length === 0) await closeRun(sql);
    console.log(
      `REPORT  e2e-run — dropped ${dropped.length} identity(ies), ${clients} OAuth client(s), run ${failed.length === 0 ? "closed" : "left open"}.`,
    );
  } finally {
    await sql.end();
  }

  if (failed.length > 0) {
    throw new Error(`e2e-run: ${failed.length} row set(s) left under an open run: ${failed.join(", ")}`);
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // Every spec's inline `auth.users` insert runs after this, in the same suite.
  assertSuiteDatabase();
  // Held open for the suite's life: the heartbeat `openRun` starts writes
  // through this client.
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const runId = await openRun("e2e", sql);
  process.env.HARNESS_RUN_ID = runId;
  console.log(`e2e-run: opened run ${runId}`);

  try {
    runScript("scripts/harness/mint-session.ts", runId);
    runScript("scripts/harness/seed-goal.ts", runId);
  } catch (error) {
    await dropRun(sql);
    throw error;
  }

  return () => dropRun(sql);
}
