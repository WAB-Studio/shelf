/**
 * Drives the grant layer of `reading.word_answers`, `reading.phrase_notes`
 * and `reading.client_spend` against the real database — DELETE never even
 * attempted, because SELECT and INSERT alone already prove the REVOKE
 * (AGENTS.md, "Code"). No policy exists on these three, so no
 * `auth.users` row is needed for a role switch to mean anything, unlike
 * `check-sync.ts`'s subjects — the block is at the GRANT/REVOKE layer alone.
 *
 * Two `sql.begin` blocks, one per role, each forced to ROLLBACK at the end
 * so the transaction touches nothing real even where a grant would have let
 * a statement through.
 */
import { randomUUID } from "node:crypto";

import { assertSuiteDatabase } from "@repo/harness-registry";
import postgres from "postgres";

assertSuiteDatabase();

const sql = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 1,
  connection: { search_path: "reading, public" },
});

let failed = false;

function assert(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!ok) failed = true;
}

// Mirrors `check-sync.ts` and `check-decoration.ts`: no cause chain to walk
// outside drizzle, so the driver's own PostgresError is the thrown value.
function pgCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error as { code: unknown };
  return typeof code === "string" ? code : undefined;
}

// A savepoint per attempt: one 42501 must not abort the statements after it,
// the way an unguarded statement would abort the whole transaction.
async function denied(
  tx: postgres.TransactionSql,
  label: string,
  fn: (sp: postgres.TransactionSql) => Promise<unknown>,
): Promise<void> {
  let code: string | undefined;
  await tx.savepoint((sp) => fn(sp)).catch((error: unknown) => {
    code = pgCode(error);
  });
  assert(label, code === "42501", `sqlstate = ${code ?? "none — the statement went through"}`);
}

// `set_config` alone, never `settleSessionSql`: that helper hardcodes
// `role = 'authenticated'`, and this script needs `anon` too. No JWT claims
// either — with zero policies on these three tables, nothing reads them.
async function enterRole(tx: postgres.TransactionSql, role: "anon" | "authenticated"): Promise<void> {
  await tx`select set_config('role', ${role}, true)`;
}

async function checkRole(role: "anon" | "authenticated"): Promise<void> {
  const forcedRollback = Symbol("forced rollback");
  await sql
    .begin(async (tx) => {
      await enterRole(tx, role);

      await denied(tx, `${role} select word_answers`, (sp) => sp`select 1 from reading.word_answers limit 1`);
      await denied(
        tx,
        `${role} insert word_answers`,
        (sp) => sp`
          insert into reading.word_answers (word, translations, example_en, example_es, model)
          values ('permcheck', array['x'], 'x', 'x', 'z')`,
      );

      await denied(tx, `${role} select phrase_notes`, (sp) => sp`select 1 from reading.phrase_notes limit 1`);
      await denied(
        tx,
        `${role} insert phrase_notes`,
        (sp) => sp`
          insert into reading.phrase_notes (phrase_hash, notes, model)
          values ('permcheck', '[]'::jsonb, 'z')`,
      );

      await denied(tx, `${role} select client_spend`, (sp) => sp`select 1 from reading.client_spend limit 1`);
      await denied(
        tx,
        `${role} insert client_spend`,
        (sp) => sp`
          insert into reading.client_spend (day, client, calls)
          values (current_date, 'permcheck', 0)`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });
}

// A device's retirement is stored and final. Unlike the blocks
// above these need a real policy subject, so two `auth.users` rows are
// inserted inside the transaction and the forced rollback takes them back.
async function enterUserContext(tx: postgres.TransactionSql, subject: string): Promise<void> {
  const claims = JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" });
  await tx`select
    set_config('request.jwt.claims', ${claims}, true),
    set_config('search_path', 'reading, public', true),
    set_config('role', 'authenticated', true)`;
}

async function checkRetirement(): Promise<void> {
  const forcedRollback = Symbol("forced rollback");
  const owner = randomUUID();
  const stranger = randomUUID();
  const retiredDevice = randomUUID();
  const liveDevice = randomUUID();

  const insertLookup = (tx: postgres.TransactionSql, device: string, localId: number) =>
    tx`insert into reading.lookups
      (user_id, device_id, local_id, at, text, normalised, kind, outcome, senses, dictionary_ready, record_schema)
      values (${owner}, ${device}, ${localId}, now(), 'x', 'x', 'word', 'exact', 0, true, 1)`;

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${owner}), (${stranger})`;
      await enterUserContext(tx, owner);
      await tx`insert into reading.devices (user_id, device_id, label)
        values (${owner}, ${retiredDevice}, 'chrome:android'), (${owner}, ${liveDevice}, 'chrome:android')`;

      const retire = await tx`update reading.devices set retired_at = now()
        where user_id = ${owner} and device_id = ${retiredDevice}`;
      assert("G1", retire.count === 1, `rows retired = ${retire.count}`);

      let reviveCode: string | undefined;
      let reviveRows: number | undefined;
      await tx
        .savepoint(async (sp) => {
          reviveRows = (await sp`update reading.devices set retired_at = null
            where user_id = ${owner} and device_id = ${retiredDevice}`).count;
        })
        .catch((error: unknown) => {
          reviveCode = pgCode(error);
        });
      const [still] = await tx<{ retired: boolean }[]>`
        select retired_at is not null as retired from reading.devices
        where user_id = ${owner} and device_id = ${retiredDevice}`;
      assert(
        "G2",
        reviveCode === "23514" && still.retired,
        `sqlstate = ${reviveCode ?? "none"}, rows = ${reviveRows ?? "n/a"}, still retired = ${still.retired}`,
      );

      let retiredInsertCode: string | undefined;
      await tx.savepoint((sp) => insertLookup(sp, retiredDevice, 1)).catch((error: unknown) => {
        retiredInsertCode = pgCode(error);
      });
      const [{ count: onRetired }] = await tx<{ count: string }[]>`
        select count(*)::text as count from reading.lookups where user_id = ${owner} and device_id = ${retiredDevice}`;
      assert("G3", retiredInsertCode === "42501" && onRetired === "0", `sqlstate = ${retiredInsertCode ?? "none"}, rows = ${onRetired}`);

      const live = await insertLookup(tx, liveDevice, 1);
      assert("G4", live.count === 1, `rows inserted = ${live.count}`);

      await enterUserContext(tx, stranger);
      const foreign = await tx`update reading.devices set retired_at = now()
        where user_id = ${owner} and device_id = ${liveDevice}`;
      await enterUserContext(tx, owner);
      const [untouched] = await tx<{ retired: boolean }[]>`
        select retired_at is not null as retired from reading.devices
        where user_id = ${owner} and device_id = ${liveDevice}`;
      assert("G5", foreign.count === 0 && !untouched.retired, `rows affected = ${foreign.count}, retired = ${untouched.retired}`);

      // A deleted row would take its retirement with it, and the next sync would seal the id afresh.
      let deleteCode: string | undefined;
      await tx
        .savepoint((sp) => sp`delete from reading.devices where user_id = ${owner} and device_id = ${retiredDevice}`)
        .catch((error: unknown) => {
          deleteCode = pgCode(error);
        });
      const [kept] = await tx<{ retired: boolean }[]>`
        select retired_at is not null as retired from reading.devices
        where user_id = ${owner} and device_id = ${retiredDevice}`;
      assert("G6", deleteCode === "42501" && kept?.retired === true, `sqlstate = ${deleteCode ?? "none"}, row kept retired = ${kept?.retired}`);

      // `retireDevice`'s own path for a device that never synced: its row is born retired.
      const bornRetired = randomUUID();
      let bornCode: string | undefined;
      await tx
        .savepoint((sp) => sp`insert into reading.devices (user_id, device_id, label, retired_at)
          values (${owner}, ${bornRetired}, 'unknown:unknown', now())`)
        .catch((error: unknown) => {
          bornCode = pgCode(error);
        });
      let bornLookupCode: string | undefined;
      await tx.savepoint((sp) => insertLookup(sp, bornRetired, 1)).catch((error: unknown) => {
        bornLookupCode = pgCode(error);
      });
      assert(
        "G7",
        bornCode === undefined && bornLookupCode === "42501",
        `device insert sqlstate = ${bornCode ?? "none"}, lookup insert sqlstate = ${bornLookupCode ?? "none"}`,
      );

      // No `where`, no `returning`: only the UPDATE policy's own `using` picks the rows this
      // statement reaches. A column reference would bring the SELECT policy in and hide the gap.
      await enterUserContext(tx, stranger);
      let sweepCode: string | undefined;
      await tx
        .savepoint((sp) => sp`update reading.devices set last_seen_at = '2001-01-01T00:00:00Z'`)
        .catch((error: unknown) => {
          sweepCode = pgCode(error);
        });
      await enterUserContext(tx, owner);
      const [swept] = await tx<{ year: number }[]>`
        select extract(year from last_seen_at)::int as year from reading.devices
        where user_id = ${owner} and device_id = ${liveDevice}`;
      assert("G8", sweepCode === undefined && swept.year !== 2001, `sqlstate = ${sweepCode ?? "none"}, owner's last_seen year = ${swept.year}`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });
}

async function main() {
  await checkRole("anon");
  await checkRole("authenticated");
  await checkRetirement();

  await sql.end();
  if (failed) process.exit(1);
}

main();
