// Proves the dedupe at the top of 0015 (RP-19, RP-22): it keeps the oldest fact
// of a one-off by (day, written_at, id) and aborts rather than lose a note.
// Runs the migration's own two statements, read from the file, on a table
// whose index is dropped inside a transaction the check rolls back.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import { assertSuiteDatabase } from "@repo/harness-registry";
import postgres from "postgres";

import { adminSql } from "../mcp/lib/people";

assertSuiteDatabase();

const admin = adminSql();
const rollback = Symbol("rollback");
const statements = readFileSync(new URL("../../db/migrations/0015_auditoria.sql", import.meta.url), "utf8").split("--> statement-breakpoint");
const guard = statements.find((s) => s.includes("DO $$"));
const dedupe = statements.find((s) => s.includes("DELETE FROM"));
assert.ok(guard && dedupe, "0015 no longer holds the guard and the dedupe");

after(() => admin.end());

async function rolledBack(body: (tx: postgres.TransactionSql, oneOff: string, person: string) => Promise<void>): Promise<void> {
  const person = randomUUID();
  await admin
    .begin(async (tx) => {
      await tx.unsafe('DROP INDEX goals."facts_one_off_unique"');
      await tx`insert into auth.users (id) values (${person})`;
      const [oneOff] = await tx<{ id: string }[]>`insert into goals.one_offs (user_id, name, day) values (${person}, 'suelta', current_date) returning id`;
      await body(tx, oneOff.id, person);
      throw rollback;
    })
    .catch((error: unknown) => {
      if (error !== rollback) throw error;
    });
}

async function fact(tx: postgres.TransactionSql, person: string, oneOff: string, day: string, writtenAt: string, note: string | null): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into goals.facts (user_id, one_off_id, day, written_at, note)
    values (${person}, ${oneOff}, ${day}::date, ${writtenAt}::timestamptz, ${note}) returning id`;
  return row.id;
}

async function guardCode(tx: postgres.TransactionSql): Promise<{ code?: string; message?: string }> {
  let caught: { code?: string; message?: string } = {};
  await tx.savepoint((sp) => sp.unsafe(guard!)).catch((error: unknown) => {
    caught = error as { code?: string; message?: string };
  });
  return caught;
}

test("three facts of a one-off leave the one with the least (day, written_at, id)", async () => {
  await rolledBack(async (tx, oneOff, person) => {
    await fact(tx, person, oneOff, "2026-10-02", "2026-10-02T10:00:00Z", null);
    const oldest = await fact(tx, person, oneOff, "2026-10-01", "2026-10-03T10:00:00Z", null);
    await fact(tx, person, oneOff, "2026-10-01", "2026-10-04T10:00:00Z", null);
    await tx.unsafe(guard!);
    await tx.unsafe(dedupe!);
    const left = await tx<{ id: string }[]>`select id from goals.facts where one_off_id = ${oneOff}`;
    assert.deepEqual([...left].map((r) => r.id), [oldest]);
  });
});

test("two facts with notes 'a' and 'b' abort the guard and delete nothing", async () => {
  await rolledBack(async (tx, oneOff, person) => {
    await fact(tx, person, oneOff, "2026-10-01", "2026-10-01T10:00:00Z", "a");
    await fact(tx, person, oneOff, "2026-10-02", "2026-10-02T10:00:00Z", "b");
    const error = await guardCode(tx);
    assert.equal(error.code, "P0001");
    assert.match(error.message ?? "", /0015: 1 one-off\(s\) hold a duplicate fact whose note would be lost/);
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from goals.facts where one_off_id = ${oneOff}`;
    assert.equal(n, 2);
  });
});

test("a kept fact with no note and a later one with note 'b' abort the guard", async () => {
  await rolledBack(async (tx, oneOff, person) => {
    await fact(tx, person, oneOff, "2026-10-01", "2026-10-01T10:00:00Z", null);
    await fact(tx, person, oneOff, "2026-10-02", "2026-10-02T10:00:00Z", "b");
    assert.equal((await guardCode(tx)).code, "P0001");
  });
});

test("a later fact with no note, or the same note, does not abort", async () => {
  await rolledBack(async (tx, oneOff, person) => {
    await fact(tx, person, oneOff, "2026-10-01", "2026-10-01T10:00:00Z", "a");
    await fact(tx, person, oneOff, "2026-10-02", "2026-10-02T10:00:00Z", null);
    await fact(tx, person, oneOff, "2026-10-03", "2026-10-03T10:00:00Z", "a");
    assert.deepEqual(await guardCode(tx), {});
  });
});
