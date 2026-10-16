// Child process of `entrar-invitacion.spec.ts`: opens a run of its own, mints a session under it
// through the real `mint-session.ts`, drops the run through the real `dropRun`, and reports what
// `goals.allowed_emails` held before and after. A run of its own, because `dropRun` drops every
// identity of the run it is given and the suite's run is not this file's to drop.
import { randomUUID } from "node:crypto";

import { openRun } from "@repo/harness-registry";
import postgres from "postgres";

import { dropRun, runScript } from "../scripts/harness/e2e-run";

const url = process.env.MIGRATION_DATABASE_URL!;
const sql = postgres(url, { prepare: false, max: 1 });
const look = postgres(url, { prepare: false, max: 1 });

async function listed(email: string): Promise<boolean> {
  const rows = await look`select 1 from goals.allowed_emails where email = ${email}`;
  return rows.length > 0;
}

async function main(): Promise<void> {
  const runId = await openRun("e2e", sql);
  process.env.HARNESS_RUN_ID = runId;
  // Another lane's identity: the same shape of address, registered under no run of this process.
  const stranger = `harness-pulsar-${randomUUID()}@example.invalid`;
  let result: Record<string, unknown> = {};
  try {
    runScript("scripts/harness/mint-session.ts", runId);
    const [identity] = await look<{ email: string }[]>`select email from harness.identities where run_id = ${runId}`;
    await look`insert into goals.allowed_emails (email) values (${stranger})`;
    const before = await listed(identity.email);
    await dropRun(sql);
    result = {
      email: identity.email,
      before,
      after: await listed(identity.email),
      strangerKept: await listed(stranger),
    };
  } finally {
    await look`delete from goals.allowed_emails where email = ${stranger}`;
    await look.end();
  }
  console.log(`RESULT ${JSON.stringify(result)}`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
