/**
 * Drives `scripts/allow-email.ts` (RL-69) as a process, against the local stack
 * (`scripts/supabase-local.sh exec`): the list row, the Auth user the script
 * creates through the admin API, and the inbox (mailpit, :54324) that must stay
 * empty. Every address is `harness-allow-<uuid>@example.invalid`, registered
 * under this run and dropped by exact address on the way in and the way out.
 * Nothing is typed into `/cuenta` and no email leaves the machine.
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
function allowEmail(arg: string, key = SERVICE_KEY): Ran {
  const run = spawnSync("node", ["--import", "tsx", "scripts/allow-email.ts", arg], {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, SUPABASE_SERVICE_ROLE_KEY: key },
    timeout: 60_000,
  });
  return { code: run.status, out: `${run.stdout}\n${run.stderr}` };
}

const authUsers = (email: string) =>
  sql<{ id: string; confirmed: boolean }[]>`
    select id, email_confirmed_at is not null as confirmed from auth.users where email = ${email}`;
const listRows = async (email: string) =>
  (await sql`select 1 from reading.allowed_emails where email = ${email}`).length;

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
  await sql`delete from reading.allowed_emails where email = ${email}`;
}

async function main() {
  await openRun("rls", sql);
  const fresh = `harness-allow-${randomUUID()}@example.invalid`;
  const preexisting = `harness-allow-${randomUUID()}@example.invalid`;
  const unconfirmedKey = `harness-allow-${randomUUID()}@example.invalid`;
  const badShape = "nobody@nodot";
  const all = [fresh, preexisting, unconfirmedKey, badShape];
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(apiUrl, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    for (const email of all) await forget(email);
    const before = (await sql`select count(*)::int as n from reading.allowed_emails`)[0].n as number;

    const bad = allowEmail(badShape);
    assert(
      "a string that is not an address (the stored column would take it) exits 1 and lists nothing",
      bad.code === 1 && ((await sql`select count(*)::int as n from reading.allowed_emails`)[0].n as number) === before,
      `exit=${bad.code}`,
    );

    // First run, typed with capitals and spaces: stored in one shape.
    const typed = ` ${fresh.replace("harness-allow", "Harness-Allow")} `;
    const first = allowEmail(typed);
    await register(fresh);
    const firstUsers = await authUsers(fresh);
    assert(
      "the first run answers agregado and exits 0",
      first.code === 0 && /agregado/.test(first.out) && !/ya estaba/.test(first.out),
      `exit=${first.code} out=${first.out.trim().slice(0, 160)}`,
    );
    assert("the address is listed once, lowercase and trimmed", (await listRows(fresh)) === 1, `rows=${await listRows(fresh)}`);
    assert(
      "the first run created exactly one Auth user, already confirmed",
      firstUsers.length === 1 && firstUsers[0].confirmed,
      `users=${firstUsers.length} confirmed=${firstUsers[0]?.confirmed}`,
    );
    assert("no email was sent to the address", (await mailTo(fresh)) === 0, `mailpit=${await mailTo(fresh)}`);

    // Second run: nothing new anywhere.
    const second = allowEmail(fresh);
    const secondUsers = await authUsers(fresh);
    assert(
      "the second run answers ya estaba and exits 0",
      second.code === 0 && /ya estaba/.test(second.out) && !/agregado/.test(second.out),
      `exit=${second.code} out=${second.out.trim().slice(0, 160)}`,
    );
    assert(
      "the second run created no second Auth user and left the first alone",
      secondUsers.length === 1 && secondUsers[0].id === firstUsers[0].id,
      `users=${secondUsers.length}`,
    );
    assert("the second run sent no email either", (await mailTo(fresh)) === 0, `mailpit=${await mailTo(fresh)}`);
    assert("the list still holds the address once", (await listRows(fresh)) === 1, `rows=${await listRows(fresh)}`);

    // An address Auth already knows is listed and its user is left as it was.
    const made = await admin.auth.admin.createUser({ email: preexisting, email_confirm: true });
    if (made.error) throw made.error;
    await register(preexisting);
    const third = allowEmail(preexisting);
    const thirdUsers = await authUsers(preexisting);
    assert(
      "an address with an Auth user already is listed and that user is untouched",
      third.code === 0 &&
        /agregado/.test(third.out) &&
        (await listRows(preexisting)) === 1 &&
        thirdUsers.length === 1 &&
        thirdUsers[0].id === made.data.user.id &&
        (await mailTo(preexisting)) === 0,
      `exit=${third.code} users=${thirdUsers.length} out=${third.out.trim().slice(0, 160)}`,
    );

    // The list comes first: Auth refusing the key still leaves the address listed.
    const refused = allowEmail(unconfirmedKey, "not-a-key");
    assert(
      "the address is listed before the Auth user is created",
      (await listRows(unconfirmedKey)) === 1 && (await authUsers(unconfirmedKey)).length === 0,
      `exit=${refused.code} rows=${await listRows(unconfirmedKey)} users=${(await authUsers(unconfirmedKey)).length}`,
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
