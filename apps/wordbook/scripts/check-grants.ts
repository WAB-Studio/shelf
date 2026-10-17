/**
 * Drives the grants of `reading`, and the policies of the two tables this
 * file proves (`lookup_tombstones`, `allowed_emails`), against the real
 * database. For `reading.word_answers`, `reading.phrase_notes` and
 * `reading.client_spend` the grant layer alone — DELETE never even
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
import { readFileSync } from "node:fs";

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

// The two tables of K1 (`0007_lookup_tombstones`, `0008_allowed_emails`), written from the contract in
// private/plan-wordbook-cuenta-2026-10-16.md and never from the migration. Each block runs in a transaction that
// is always rolled back. Two hooks run privileged at the top of that transaction, before anything is read:
// `K1_PRELUDE_SQL_FILE` builds the contract's state by hand (proving the checks green before a migration is
// applied), `K1_MUTANT_SQL` then breaks one clause of it. Neither is set in CI.
async function k1Tx(block: string, fn: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
  const forcedRollback = Symbol("forced rollback");
  const prelude = process.env.K1_PRELUDE_SQL_FILE;
  const mutant = process.env.K1_MUTANT_SQL;
  // `K1_ONLY` runs one block alone, so a mutant is proved against the case that kills it and nothing else.
  if (process.env.K1_ONLY && process.env.K1_ONLY !== block) return;
  await sql
    .begin(async (tx) => {
      if (prelude) await tx.file(prelude);
      if (mutant) {
        console.log(`MUTANT  ${mutant.replace(/\s+/g, " ").slice(0, 140)}`);
        await tx.unsafe(mutant);
      }
      await fn(tx);
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error === forcedRollback) return;
      // A block that cannot run (a table not there yet) is a red, not a crash that hides the blocks after it.
      assert(`${block} aborted`, false, `${pgCode(error) ?? "no sqlstate"} ${error instanceof Error ? error.message : String(error)}`);
    });
}

async function attemptCode(
  tx: postgres.TransactionSql,
  fn: (sp: postgres.TransactionSql) => Promise<unknown>,
): Promise<string | undefined> {
  let code: string | undefined;
  await tx.savepoint((sp) => fn(sp)).catch((error: unknown) => {
    code = pgCode(error);
  });
  return code;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

async function checkTombstoneCatalogue(): Promise<void> {
  await k1Tx("catalogue", async (tx) => {
    const tableGrants = await tx<{ grantee: string; privilege_type: string }[]>`
      select grantee, privilege_type from information_schema.role_table_grants
      where table_schema = 'reading' and table_name = 'lookup_tombstones'
        and grantee in ('anon', 'authenticated', 'service_role')`;
    const colGrants = await tx<{ grantee: string; privilege_type: string; column_name: string }[]>`
      select grantee, privilege_type, column_name from information_schema.column_privileges
      where table_schema = 'reading' and table_name = 'lookup_tombstones'
        and grantee in ('anon', 'authenticated', 'service_role')`;
    const strangers = [...tableGrants, ...colGrants].filter((g) => g.grantee !== "authenticated");
    const authTable = tableGrants.filter((g) => g.grantee === "authenticated").map((g) => g.privilege_type);
    const authInsertCols = colGrants
      .filter((g) => g.grantee === "authenticated" && g.privilege_type === "INSERT")
      .map((g) => g.column_name);
    const authOther = colGrants
      .filter((g) => g.grantee === "authenticated" && g.privilege_type !== "INSERT" && g.privilege_type !== "SELECT" && g.privilege_type !== "REFERENCES")
      .map((g) => g.privilege_type);
    assert(
      "T1",
      strangers.length === 0 &&
        authTable.includes("SELECT") &&
        !authTable.some((p) => p !== "SELECT") &&
        sameSet(authInsertCols, ["user_id", "device_id", "local_id", "received_at"]) &&
        authOther.length === 0,
      `anon/service_role grants = ${strangers.length}, authenticated table = [${authTable}], insert columns = [${authInsertCols}], other column privileges = [${authOther}]`,
    );

    const [rls] = await tx<{ on: boolean | null }[]>`
      select relrowsecurity as on from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'reading' and c.relname = 'lookup_tombstones'`;
    const policies = await tx<{ policyname: string; cmd: string }[]>`
      select policyname, cmd from pg_policies where schemaname = 'reading' and tablename = 'lookup_tombstones'`;
    assert(
      "T2",
      rls?.on === true &&
        sameSet(policies.map((p) => `${p.policyname}:${p.cmd}`), [
          "lookup_tombstones_select_self:SELECT",
          "lookup_tombstones_insert_self:INSERT",
        ]),
      `rls = ${rls?.on}, policies = [${policies.map((p) => `${p.policyname}:${p.cmd}`)}]`,
    );

    const [shape] = await tx<{ cols: string[] | null; pk: string[] | null }[]>`
      select
        (select array_agg(column_name || ':' || data_type || ':' || is_nullable order by column_name)
           from information_schema.columns where table_schema = 'reading' and table_name = 'lookup_tombstones') as cols,
        (select array_agg(a.attname::text order by array_position(i.indkey::int2[], a.attnum))
           from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
           where i.indrelid = to_regclass('reading.lookup_tombstones') and i.indisprimary) as pk`;
    assert(
      "T3",
      shape?.cols !== null &&
        sameSet(shape.cols, [
          "user_id:uuid:NO",
          "device_id:uuid:NO",
          "local_id:integer:NO",
          "received_at:timestamp with time zone:NO",
          "deleted_at:timestamp with time zone:NO",
        ]) &&
        shape.pk?.join(",") === "user_id,device_id,local_id",
      `columns = [${shape?.cols}], primary key = [${shape?.pk}]`,
    );

    const [idx] = await tx<{ cols: string[] | null }[]>`
      select (select array_agg(a.attname::text order by array_position(i.indkey::int2[], a.attnum))
              from pg_attribute a where a.attrelid = i.indrelid and a.attnum = any(i.indkey)) as cols
      from pg_index i where i.indrelid = to_regclass('reading.lookup_tombstones') and not i.indisprimary
        and (select array_agg(a.attname::text order by array_position(i.indkey::int2[], a.attnum))
             from pg_attribute a where a.attrelid = i.indrelid and a.attnum = any(i.indkey))
            = array['user_id','deleted_at','device_id','local_id']`;
    assert("T4", idx !== undefined, `download-cursor index (user_id, deleted_at, device_id, local_id) present = ${idx !== undefined}`);
  });
}

async function checkTombstoneRoles(): Promise<void> {
  await k1Tx("roles", async (tx) => {
    const a = randomUUID();
    const b = randomUUID();
    const dev = randomUUID();
    await tx`insert into auth.users (id) values (${a}), (${b})`;
    await enterUserContext(tx, a);

    const own = await tx`insert into reading.lookup_tombstones (user_id, device_id, local_id, received_at)
      values (${a}, ${dev}, 1, now() - interval '1 hour')`;
    const [stamped] = await tx<{ near: boolean }[]>`
      select abs(extract(epoch from (deleted_at - now()))) < 60 as near from reading.lookup_tombstones
      where user_id = ${a} and device_id = ${dev} and local_id = 1`;
    assert("T5", own.count === 1 && stamped?.near === true, `rows inserted = ${own.count}, deleted_at stamped by the server = ${stamped?.near}`);

    // `deleted_at` is the server's clock and the download cursor: a client that names it moves the cursor.
    const namedClock = await attemptCode(
      tx,
      (sp) => sp`insert into reading.lookup_tombstones (user_id, device_id, local_id, received_at, deleted_at)
        values (${a}, ${dev}, 2, now(), '2001-01-01T00:00:00Z')`,
    );
    assert("T6", namedClock === "42501", `sqlstate = ${namedClock ?? "none — the statement went through"}`);

    const dup = await attemptCode(
      tx,
      (sp) => sp`insert into reading.lookup_tombstones (user_id, device_id, local_id, received_at)
        values (${a}, ${dev}, 1, now())`,
    );
    const zero = await attemptCode(
      tx,
      (sp) => sp`insert into reading.lookup_tombstones (user_id, device_id, local_id, received_at)
        values (${a}, ${dev}, 0, now())`,
    );
    assert("T7", dup === "23505" && zero === "23514", `duplicate sqlstate = ${dup ?? "none"}, local_id 0 sqlstate = ${zero ?? "none"}`);

    // Under B's session, A's mark is not there to read, and A's identity is not B's to refuse.
    await enterUserContext(tx, b);
    const seen = await tx`select 1 from reading.lookup_tombstones where user_id = ${a}`;
    const seenAll = await tx`select 1 from reading.lookup_tombstones`;
    assert("T8", seen.count === 0 && seenAll.count === 0, `B reads A's marks = ${seen.count}, B reads any mark = ${seenAll.count}`);
    await enterUserContext(tx, a);
    const mine = await tx`select 1 from reading.lookup_tombstones`;
    assert("T8b", mine.count === 1, `A reads their own marks = ${mine.count}`);

    // A forges a mark in B's name: it would bury B's search.
    const forged = await attemptCode(
      tx,
      (sp) => sp`insert into reading.lookup_tombstones (user_id, device_id, local_id, received_at)
        values (${b}, ${dev}, 9, now())`,
    );
    await tx`reset role`;
    const [forgedRows] = await tx<{ n: string }[]>`select count(*)::text as n from reading.lookup_tombstones where user_id = ${b}`;
    await enterUserContext(tx, a);
    assert("T9", forged === "42501" && forgedRows.n === "0", `sqlstate = ${forged ?? "none"}, marks written in B's name = ${forgedRows.n}`);

    // A mark is final: no grant to edit it, none to remove it. 42501 names the grant, not an empty row set.
    const upd = await attemptCode(tx, (sp) => sp`update reading.lookup_tombstones set received_at = now() where user_id = ${a}`);
    const del = await attemptCode(tx, (sp) => sp`delete from reading.lookup_tombstones where user_id = ${a}`);
    await tx`reset role`;
    const [kept] = await tx<{ n: string }[]>`select count(*)::text as n from reading.lookup_tombstones where user_id = ${a}`;
    assert("T10", upd === "42501" && del === "42501" && kept.n === "1", `update sqlstate = ${upd ?? "none"}, delete sqlstate = ${del ?? "none"}, marks kept = ${kept.n}`);

    // Deleting an account takes its marks with it.
    await tx`delete from auth.users where id = ${a}`;
    const [gone] = await tx<{ n: string }[]>`select count(*)::text as n from reading.lookup_tombstones where user_id = ${a}`;
    assert("T11", gone.n === "0", `marks left after the user is deleted = ${gone.n}`);
  });
}

async function checkMarkRefusesReturn(): Promise<void> {
  await k1Tx("returns", async (tx) => {
    const a = randomUUID();
    const b = randomUUID();
    const devX = randomUUID();
    const devY = randomUUID();
    await tx`insert into auth.users (id) values (${a}), (${b})`;
    await enterUserContext(tx, a);
    const insertLookup = (sp: postgres.TransactionSql, user: string, device: string, localId: number) =>
      sp`insert into reading.lookups
        (user_id, device_id, local_id, at, text, normalised, kind, outcome, senses, dictionary_ready, record_schema)
        values (${user}, ${device}, ${localId}, now(), 'x', 'x', 'word', 'exact', 0, true, 1)`;

    await tx`insert into reading.lookup_tombstones (user_id, device_id, local_id, received_at)
      values (${a}, ${devX}, 5, now())`;

    const back = await attemptCode(tx, (sp) => insertLookup(sp, a, devX, 5));
    const [{ n: backRows }] = await tx<{ n: string }[]>`
      select count(*)::text as n from reading.lookups where user_id = ${a} and device_id = ${devX} and local_id = 5`;
    assert("L1", back === "42501" && backRows === "0", `marked identity: sqlstate = ${back ?? "none"}, rows = ${backRows}`);

    // The mark is one identity (device, number), not a device and not a number.
    const nextLocal = await attemptCode(tx, (sp) => insertLookup(sp, a, devX, 6));
    const otherDevice = await attemptCode(tx, (sp) => insertLookup(sp, a, devY, 5));
    const [{ n: kept }] = await tx<{ n: string }[]>`
      select count(*)::text as n from reading.lookups where user_id = ${a} and ((device_id = ${devX} and local_id = 6) or (device_id = ${devY} and local_id = 5))`;
    assert("L2", nextLocal === undefined && otherDevice === undefined && kept === "2", `same device other number sqlstate = ${nextLocal ?? "ok"}; other device same number sqlstate = ${otherDevice ?? "ok"}; rows = ${kept}`);

    // The clause added to the policy must not drop the old ones.
    const foreign = await attemptCode(tx, (sp) => insertLookup(sp, b, devY, 1));
    assert("L3", foreign === "42501", `insert in B's name sqlstate = ${foreign ?? "none"}`);

    await tx`reset role`;
    const retired = randomUUID();
    await tx`insert into reading.devices (user_id, device_id, label, retired_at) values (${a}, ${retired}, 'x:y', now())`;
    await enterUserContext(tx, a);
    const refused = await attemptCode(tx, (sp) => insertLookup(sp, a, retired, 1));
    assert("L4", refused === "42501", `retired device sqlstate = ${refused ?? "none"}`);
  });
}

async function checkCapCountsBuried(): Promise<void> {
  await k1Tx("cap", async (tx) => {
    const a = randomUUID();
    const b = randomUUID();
    const dev = randomUUID();
    await tx`insert into auth.users (id) values (${a}), (${b})`;
    await enterUserContext(tx, a);
    for (const localId of [1, 2, 3]) {
      await tx`insert into reading.lookups
        (user_id, device_id, local_id, at, text, normalised, kind, outcome, senses, dictionary_ready, record_schema)
        values (${a}, ${dev}, ${localId}, now(), 'x', 'x', 'word', 'exact', 0, true, 1)`;
    }
    const [before] = await tx<{ n: string }[]>`select reading.sync_rows_today(${a})::text as n`;
    // Row 3 is deleted on this device and its mark is written, carrying the deleted row's own received_at.
    const [{ received_at: receivedAt }] = await tx<{ received_at: Date }[]>`
      select received_at from reading.lookups where user_id = ${a} and device_id = ${dev} and local_id = 3`;
    await tx`delete from reading.lookups where user_id = ${a} and device_id = ${dev} and local_id = 3`;
    await tx`insert into reading.lookup_tombstones (user_id, device_id, local_id, received_at)
      values (${a}, ${dev}, 3, ${receivedAt})`;
    const [after] = await tx<{ n: string }[]>`select reading.sync_rows_today(${a})::text as n`;
    assert("C1", before.n === "3" && after.n === "3", `rows today before the delete = ${before.n}, after the delete and its mark = ${after.n}`);

    // A mark from an earlier day buys the day nothing; another reader's mark is not this reader's.
    await tx`insert into reading.lookup_tombstones (user_id, device_id, local_id, received_at)
      values (${a}, ${dev}, 4, now() - interval '3 days')`;
    const [old] = await tx<{ n: string }[]>`select reading.sync_rows_today(${a})::text as n`;
    await enterUserContext(tx, b);
    await tx`insert into reading.lookup_tombstones (user_id, device_id, local_id, received_at)
      values (${b}, ${dev}, 1, now())`;
    // Privileged, so the policies cannot hide B's mark from the function: it must tell the readers apart itself.
    await tx`reset role`;
    const [mineStill] = await tx<{ n: string }[]>`select reading.sync_rows_today(${a})::text as n`;
    assert("C2", old.n === "3" && mineStill.n === "3", `with a three-day-old mark = ${old.n}, with B's mark today = ${mineStill.n}`);

    // Same signature, same grants: only the signed-in reader may call it.
    const [can] = await tx<{ anon: boolean; authenticated: boolean; service_role: boolean; pub: boolean }[]>`
      select has_function_privilege('anon', 'reading.sync_rows_today(uuid)', 'execute') as anon,
             has_function_privilege('authenticated', 'reading.sync_rows_today(uuid)', 'execute') as authenticated,
             has_function_privilege('service_role', 'reading.sync_rows_today(uuid)', 'execute') as service_role,
             exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     where p.oid = 'reading.sync_rows_today(uuid)'::regprocedure and a.grantee = 0) as pub`;
    assert("C3", !can.anon && can.authenticated && !can.service_role && !can.pub, `EXECUTE: anon = ${can.anon}, authenticated = ${can.authenticated}, service_role = ${can.service_role}, PUBLIC = ${can.pub}`);
  });
}

async function checkAllowedEmails(): Promise<void> {
  await k1Tx("allowed", async (tx) => {
    const grants = await tx<{ n: string }[]>`
      select (select count(*) from information_schema.role_table_grants
              where table_schema = 'reading' and table_name = 'allowed_emails'
                and grantee in ('anon', 'authenticated', 'service_role'))
           + (select count(*) from information_schema.column_privileges
              where table_schema = 'reading' and table_name = 'allowed_emails'
                and grantee in ('anon', 'authenticated', 'service_role')) as n`;
    const [rls] = await tx<{ on: boolean | null }[]>`
      select relrowsecurity as on from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'reading' and c.relname = 'allowed_emails'`;
    const policies = await tx`select 1 from pg_policies where schemaname = 'reading' and tablename = 'allowed_emails'`;
    assert("E1", grants[0].n === "0" && rls?.on === true && policies.count === 0, `grants to the three roles = ${grants[0].n}, rls = ${rls?.on}, policies = ${policies.count}`);

    for (const role of ["anon", "authenticated", "service_role"] as const) {
      await tx`select set_config('role', ${role}, true)`;
      const read = await attemptCode(tx, (sp) => sp`select 1 from reading.allowed_emails limit 1`);
      const write = await attemptCode(tx, (sp) => sp`insert into reading.allowed_emails (email) values ('x@y.co')`);
      assert(`E2 ${role}`, read === "42501" && write === "42501", `select sqlstate = ${read ?? "none"}, insert sqlstate = ${write ?? "none"}`);
      await tx`reset role`;
    }

    // One stored shape: lowercase, trimmed, with something before the "@".
    const upper = await attemptCode(tx, (sp) => sp`insert into reading.allowed_emails (email) values ('Ana@x.co')`);
    const spaced = await attemptCode(tx, (sp) => sp`insert into reading.allowed_emails (email) values (' ana@x.co')`);
    const noAt = await attemptCode(tx, (sp) => sp`insert into reading.allowed_emails (email) values ('x')`);
    const bareAt = await attemptCode(tx, (sp) => sp`insert into reading.allowed_emails (email) values ('@x.co')`);
    const good = await attemptCode(tx, (sp) => sp`insert into reading.allowed_emails (email) values ('ana@x.co')`);
    const [row] = await tx<{ added: boolean }[]>`
      select added_at is not null and abs(extract(epoch from (added_at - now()))) < 60 as added
      from reading.allowed_emails where email = 'ana@x.co'`;
    assert(
      "E3",
      upper === "23514" && spaced === "23514" && noAt === "23514" && bareAt === "23514" && good === undefined && row?.added === true,
      `upper = ${upper ?? "none"}, spaced = ${spaced ?? "none"}, no @ = ${noAt ?? "none"}, bare @ = ${bareAt ?? "none"}, good = ${good ?? "ok"}, added_at stamped = ${row?.added}`,
    );
    const twice = await attemptCode(tx, (sp) => sp`insert into reading.allowed_emails (email) values ('ana@x.co')`);
    assert("E4", twice === "23505", `second 'ana@x.co' sqlstate = ${twice ?? "none"}`);

    // Readers who already own rows keep asking for a link: the migration seeded them.
    const missing = await tx<{ email: string }[]>`
      select distinct lower(btrim(u.email)) as email from auth.users u
      where u.email is not null and position('@' in lower(btrim(u.email))) > 1
        and (exists (select 1 from reading.lookups l where l.user_id = u.id)
          or exists (select 1 from reading.devices d where d.user_id = u.id))
        and not exists (select 1 from reading.allowed_emails e where e.email = lower(btrim(u.email)))`;
    const [owners] = await tx<{ n: string }[]>`
      select count(distinct u.id)::text as n from auth.users u
      where u.email is not null and (exists (select 1 from reading.lookups l where l.user_id = u.id)
          or exists (select 1 from reading.devices d where d.user_id = u.id))`;
    assert("E5", missing.length === 0, `owners with an address = ${owners.n}, missing from the list = ${missing.length}`);
  });
}

// A row and a mark of the same identity while the row is still there: the client may write the mark itself (its
// insert policy allows it), and the day's cap must not count that search twice.
async function checkMarkBesideItsRow(): Promise<void> {
  await k1Tx("cap-live", async (tx) => {
    const a = randomUUID();
    const dev = randomUUID();
    await tx`insert into auth.users (id) values (${a})`;
    await enterUserContext(tx, a);
    await tx`insert into reading.lookups
      (user_id, device_id, local_id, at, text, normalised, kind, outcome, senses, dictionary_ready, record_schema)
      values (${a}, ${dev}, 1, now(), 'x', 'x', 'word', 'exact', 0, true, 1)`;
    const [before] = await tx<{ n: string }[]>`select reading.sync_rows_today(${a})::text as n`;
    const [{ received_at: receivedAt }] = await tx<{ received_at: Date }[]>`
      select received_at from reading.lookups where user_id = ${a} and device_id = ${dev} and local_id = 1`;
    const markCode = await attemptCode(tx, (sp) => sp`insert into reading.lookup_tombstones (user_id, device_id, local_id, received_at)
      values (${a}, ${dev}, 1, ${receivedAt})`);
    const [after] = await tx<{ n: string }[]>`select reading.sync_rows_today(${a})::text as n`;
    assert("C4", before.n === "1" && markCode === undefined && after.n === "1", `rows today with the row alone = ${before.n}, mark insert sqlstate = ${markCode ?? "ok"}, with the row and its own mark = ${after.n}`);
  });
}

// The migration's own seed, read from 0008 and run against readers this block creates: one keeps only a device, one
// only searches, one an untidy address, two a malformed one, one nothing at all.
async function checkSeedBranches(): Promise<void> {
  const migration = readFileSync(new URL("../db/migrations/0008_allowed_emails.sql", import.meta.url), "utf8");
  const seed = migration.split("--> statement-breakpoint").find((chunk) => /INSERT INTO\s+"reading"\."allowed_emails"/i.test(chunk));
  await k1Tx("seed", async (tx) => {
    if (!seed) {
      assert("E6", false, "no INSERT into allowed_emails in 0008_allowed_emails.sql");
      return;
    }
    const tag = randomUUID().slice(0, 8);
    const readers = {
      device: { id: randomUUID(), email: `seed-device-${tag}@example.invalid` },
      lookup: { id: randomUUID(), email: `seed-lookup-${tag}@example.invalid` },
      untidy: { id: randomUUID(), email: ` Ana-${tag}@X.co ` },
      noAt: { id: randomUUID(), email: `nomail${tag}` },
      bareAt: { id: randomUUID(), email: `@${tag}.co` },
      idle: { id: randomUUID(), email: `seed-idle-${tag}@example.invalid` },
    };
    for (const { id, email } of Object.values(readers)) await tx`insert into auth.users (id, email) values (${id}, ${email})`;
    await tx`insert into reading.devices (user_id, device_id, label) values (${readers.device.id}, ${randomUUID()}, 'x:y')`;
    for (const who of [readers.lookup, readers.untidy, readers.noAt, readers.bareAt]) {
      await tx`insert into reading.lookups
        (user_id, device_id, local_id, at, text, normalised, kind, outcome, senses, dictionary_ready, record_schema)
        values (${who.id}, ${randomUUID()}, 1, now(), 'x', 'x', 'word', 'exact', 0, true, 1)`;
    }
    const mine = Object.values(readers).map((r) => r.email.trim().toLowerCase());
    const listed = async () =>
      (await tx<{ email: string }[]>`select email from reading.allowed_emails where email in ${tx(mine)}`).map((r) => r.email);
    const before = await listed();
    const seedCode = await attemptCode(tx, (sp) => sp.unsafe(seed));
    const after = await listed();
    const expected = [readers.device.email, readers.lookup.email, `ana-${tag}@x.co`];
    assert("E6", before.length === 0 && sameSet(after, expected), `listed before the seed = ${before.length}, after = [${after.sort().join(", ")}], owed = [${expected.sort().join(", ")}]`);
    assert(
      "E7",
      seedCode === undefined && !after.includes(`nomail${tag}`) && !after.includes(`@${tag}.co`),
      `seed sqlstate = ${seedCode ?? "ok"}, malformed listed = ${after.filter((e) => !e.includes("@") || e.startsWith("@")).join(", ") || "none"}`,
    );
  });
}

async function checkMigrationsInOrder(): Promise<void> {
  const journal = JSON.parse(readFileSync(new URL("../db/migrations/meta/_journal.json", import.meta.url), "utf8")) as {
    entries: { idx: number; when: number; tag: string }[];
  };
  const tags = journal.entries.map((e) => e.tag);
  const increasing = journal.entries.every((e, i) => e.idx === i && (i === 0 || e.when > journal.entries[i - 1].when));
  assert(
    "M1",
    journal.entries.length === 9 &&
      tags[7] === "0007_lookup_tombstones" &&
      tags[8] === "0008_allowed_emails" &&
      journal.entries[7].when > 1791606395820 &&
      increasing,
    `entries = ${journal.entries.length}, tags 7..8 = [${tags.slice(7, 9)}], idx and when strictly increasing = ${increasing}`,
  );
  const [applied] = await sql<{ n: string }[]>`select count(*)::text as n from drizzle.__drizzle_migrations_reading`;
  assert("M2", applied.n === "9", `rows in __drizzle_migrations_reading = ${applied.n}`);
}

async function main() {
  await checkRole("anon");
  await checkRole("authenticated");
  await checkRetirement();
  await checkTombstoneCatalogue();
  await checkTombstoneRoles();
  await checkMarkRefusesReturn();
  await checkCapCountsBuried();
  await checkAllowedEmails();
  await checkMarkBesideItsRow();
  await checkSeedBranches();
  await checkMigrationsInOrder();

  await sql.end();
  if (failed) process.exit(1);
}

main();
