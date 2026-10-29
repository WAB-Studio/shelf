// Proves RP-19 and RP-22 at the index (0015): a one-off holds at most one fact,
// a commitment still holds one per day. Driven as `authenticated` in a
// transaction the check rolls back; no row survives.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { assertSuiteDatabase } from "@repo/harness-registry";
import postgres from "postgres";

import { adminSql } from "../mcp/lib/people";

assertSuiteDatabase();

const admin = adminSql();
const rollback = Symbol("rollback");

after(() => admin.end());

async function rolledBack(body: (tx: postgres.TransactionSql, person: string) => Promise<void>): Promise<void> {
  const person = randomUUID();
  await admin
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${person})`;
      await body(tx, person);
      throw rollback;
    })
    .catch((error: unknown) => {
      if (error !== rollback) throw error;
    });
}

async function asPerson(tx: postgres.TransactionSql, person: string): Promise<void> {
  const claims = JSON.stringify({ sub: person, role: "authenticated", aud: "authenticated" });
  await tx`select set_config('request.jwt.claims', ${claims}, true), set_config('search_path', 'goals, public', true), set_config('role', 'authenticated', true)`;
}

async function codeOf(tx: postgres.TransactionSql, fn: (sp: postgres.TransactionSql) => Promise<unknown>): Promise<string | undefined> {
  let code: string | undefined;
  await tx.savepoint((sp) => fn(sp)).catch((error: unknown) => {
    code = (error as { code?: string }).code;
  });
  return code;
}

test("a second fact for one one-off is refused with 23505, a fact of another one-off is not", async () => {
  await rolledBack(async (tx, person) => {
    const [a] = await tx<{ id: string }[]>`insert into goals.one_offs (user_id, name, day) values (${person}, 'a', current_date) returning id`;
    const [b] = await tx<{ id: string }[]>`insert into goals.one_offs (user_id, name, day) values (${person}, 'b', current_date) returning id`;
    await asPerson(tx, person);
    await tx`insert into goals.facts (user_id, one_off_id, day) values (${person}, ${a.id}, current_date)`;
    const again = await codeOf(tx, (sp) => sp`insert into goals.facts (user_id, one_off_id, day) values (${person}, ${a.id}, current_date - 1)`);
    assert.equal(again, "23505", "the second fact of one one-off went in");
    const other = await codeOf(tx, (sp) => sp`insert into goals.facts (user_id, one_off_id, day) values (${person}, ${b.id}, current_date)`);
    assert.equal(other, undefined, "a fact of a different one-off was refused");
  });
});

test("two facts of one commitment on different days both go in", async () => {
  await rolledBack(async (tx, person) => {
    const [goal] = await tx<{ id: string }[]>`insert into goals.goals (user_id, name, horizon) values (${person}, 'meta', '2027-12-31') returning id`;
    const [c] = await tx<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
      values (${person}, ${goal.id}, 'tap', 'daily', 'tap') returning id`;
    await asPerson(tx, person);
    const first = await codeOf(tx, (sp) => sp`insert into goals.facts (user_id, commitment_id, day) values (${person}, ${c.id}, current_date)`);
    const second = await codeOf(tx, (sp) => sp`insert into goals.facts (user_id, commitment_id, day) values (${person}, ${c.id}, current_date - 1)`);
    assert.equal(first, undefined);
    assert.equal(second, undefined, "the index took the commitment's second day");
  });
});
