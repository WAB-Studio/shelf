/**
 * Drives `scripts/allow-email.ts` (RP-131) as a process, against the local stack
 * (`scripts/supabase-local.sh exec`): the list row, the Auth user the script
 * creates through the admin API, and the inbox (mailpit, :54324) that must stay
 * empty. Every address is `harness-allow-<uuid>@example.invalid`, registered
 * under this run and dropped by exact address on the way in and the way out.
 *
 * The service-role key of the local stack comes from the Supabase CLI, the same
 * way the script under test takes it from its own environment.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { assertSuiteDatabase, closeRun, openRun } from "@repo/harness-registry";
import postgres from "postgres";

assertSuiteDatabase();

const MAILBOX = "http://127.0.0.1:54324";
const root = resolve(import.meta.dirname, "../../..");

const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(apiUrl)) {
  throw new Error(`check-allow-email: ${apiUrl || "no API url"} is not the local stack; run through scripts/supabase-local.sh exec`);
}

function localServiceRoleKey(): string {
  const out = execFileSync("npx", ["--yes", "supabase@2.119.0", "status", "-o", "env"], { cwd: root, encoding: "utf8" });
  const key = /^SERVICE_ROLE_KEY="(.*)"$/m.exec(out)?.[1];
  if (!key) throw new Error("check-allow-email: the local stack gave no service-role key");
  return key;
}
const SERVICE_KEY = localServiceRoleKey();

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });

let failed = false;
let n = 0;
function assert(name: string, ok: boolean, detail: string): void {
  n += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  A${n}. ${name} — ${detail}`);
  if (!ok) failed = true;
}

type Ran = { code: number | null; out: string };
// `key` null leaves the variable unset in the child, as on a machine that never exported it.
function allowEmail(arg: string, key: string | null = SERVICE_KEY): Ran {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (key === null) delete env.SUPABASE_SERVICE_ROLE_KEY;
  else env.SUPABASE_SERVICE_ROLE_KEY = key;
  const run = spawnSync("node", ["--import", "tsx", "scripts/allow-email.ts", arg], {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  return { code: run.status, out: `${run.stdout}\n${run.stderr}` };
}

const authUsers = (email: string) =>
  sql<{ id: string; confirmed: boolean }[]>`
    select id, email_confirmed_at is not null as confirmed from auth.users where email = ${email}`;
const listRows = async (email: string) =>
  (await sql`select 1 from goals.allowed_emails where email = ${email}`).length;

async function mailTo(email: string): Promise<number> {
  const found = await (await fetch(`${MAILBOX}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
  return (found.messages ?? []).length;
}

async function register(email: string): Promise<void> {
  const runId = process.env.HARNESS_RUN_ID ?? (await openRun("rls", sql));
  await sql`
    insert into harness.identities (user_id, run_id, email, disposition)
    select id, ${runId}, email, 'ephemeral' from auth.users where email = ${email}
    on conflict do nothing`;
}

async function forget(email: string): Promise<void> {
  for (const { id } of await authUsers(email)) {
    await sql`delete from harness.identities where user_id = ${id}`;
    await sql`delete from auth.users where id = ${id}`;
  }
  await sql`delete from goals.allowed_emails where email = ${email}`;
}

async function main() {
  await openRun("rls", sql);
  const fresh = `harness-allow-${randomUUID()}@example.invalid`;
  const noKey = `harness-allow-${randomUUID()}@example.invalid`;
  const badShapes = ["x", "@b.co", "a@b"];
  const all = [fresh, noKey];

  try {
    for (const email of all) await forget(email);
    const count = async () => (await sql`select count(*)::int as n from goals.allowed_emails`)[0].n as number;

    const before = await count();
    for (const bad of badShapes) {
      const ran = allowEmail(bad);
      assert(
        `«${bad}» is not an address: exit 1 and nothing listed`,
        ran.code === 1 && (await count()) === before,
        `exit=${ran.code} rows=${await count()} (was ${before})`,
      );
    }

    const first = allowEmail(fresh);
    await register(fresh);
    const firstUsers = await authUsers(fresh);
    assert(
      "the first run answers agregado, creates the user (not ya tenía usuario) and exits 0",
      first.code === 0 && /agregado/.test(first.out) && !/ya estaba/.test(first.out) && !/ya tenía usuario/.test(first.out),
      `exit=${first.code} out=${first.out.trim().slice(0, 160)}`,
    );
    assert("the address is listed once", (await listRows(fresh)) === 1, `rows=${await listRows(fresh)}`);
    assert(
      "the first run created exactly one Auth user, already confirmed",
      firstUsers.length === 1 && firstUsers[0].confirmed,
      `users=${firstUsers.length} confirmed=${firstUsers[0]?.confirmed}`,
    );
    assert("no email was sent to the address", (await mailTo(fresh)) === 0, `mailpit=${await mailTo(fresh)}`);

    const second = allowEmail(fresh);
    const secondUsers = await authUsers(fresh);
    assert(
      "the second run answers ya estaba and exits 0",
      second.code === 0 && /ya estaba/.test(second.out) && !/agregado/.test(second.out),
      `exit=${second.code} out=${second.out.trim().slice(0, 160)}`,
    );
    assert(
      "the second run answers ya tenía usuario, creates no second user and leaves the first alone",
      /ya tenía usuario/.test(second.out) && secondUsers.length === 1 && secondUsers[0].id === firstUsers[0].id,
      `users=${secondUsers.length} out=${second.out.trim().slice(0, 160)}`,
    );
    assert("the second run sent no email either", (await mailTo(fresh)) === 0, `mailpit=${await mailTo(fresh)}`);

    // Listed before created: without the key the address stays listed and no user exists.
    const unkeyed = allowEmail(noKey, null);
    assert(
      "with the key unset the run exits 1, never 0",
      unkeyed.code === 1,
      `exit=${unkeyed.code} out=${unkeyed.out.trim().slice(0, 160)}`,
    );
    assert(
      "with the key unset the address stays listed and has no Auth user",
      (await listRows(noKey)) === 1 && (await authUsers(noKey)).length === 0,
      `rows=${await listRows(noKey)} users=${(await authUsers(noKey)).length}`,
    );
    const rerun = allowEmail(noKey);
    await register(noKey);
    const rerunUsers = await authUsers(noKey);
    assert(
      "a rerun with the key completes it: ya estaba, one confirmed user, exit 0",
      rerun.code === 0 && /ya estaba/.test(rerun.out) && rerunUsers.length === 1 && rerunUsers[0].confirmed,
      `exit=${rerun.code} users=${rerunUsers.length} out=${rerun.out.trim().slice(0, 160)}`,
    );
  } finally {
    for (const email of all) await forget(email);
    await closeRun(sql);
    await sql.end();
  }

  console.log(`\nREPORT  ${n} asserted, ${failed ? "FAILED" : "all passed"}`);
  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
