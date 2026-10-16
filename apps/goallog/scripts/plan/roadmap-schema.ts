// Drives `0013`'s data move and insert trigger through the pooler: every row that
// had a month or a parent is in the plan, and a month never moved. The fixture
// months are read back as the migration left them.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

after(async () => {
  await sql.end();
});

test("no row with a month or a parent is outside the plan", async () => {
  const [{ n }] = await sql<{ n: string }[]>`
    select count(*)::text as n from goals.one_offs
    where (planned_month is not null or parent_id is not null) and not in_plan`;
  assert.equal(n, "0");
});

test("a plan row has a goal, no day, and a first-of-month fixed month", async () => {
  const [{ n }] = await sql<{ n: string }[]>`
    select count(*)::text as n from goals.one_offs
    where in_plan and (
      goal_id is null or day is not null
      or (planned_month is not null and planned_month <> date_trunc('month', planned_month)::date)
    )`;
  assert.equal(n, "0");
});

test("an insert with a month lands in the plan, one with neither stays out", async () => {
  const user = crypto.randomUUID();
  const rollback = Symbol("rollback");
  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${user})`;
      const [goal] = await tx<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${user}, 'meta', '2027-12-31') returning id`;
      const [dated] = await tx<{ in_plan: boolean; planned_month: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, planned_month)
        values (${user}, ${goal.id}, 'a', '2026-12-01') returning in_plan, planned_month::text`;
      const [loose] = await tx<{ in_plan: boolean }[]>`
        insert into goals.one_offs (user_id, goal_id, name, day) values (${user}, ${goal.id}, 'b', current_date) returning in_plan`;
      assert.equal(dated.in_plan, true);
      assert.equal(dated.planned_month, "2026-12-01");
      assert.equal(loose.in_plan, false);
      throw rollback;
    })
    .catch((error: unknown) => {
      if (error !== rollback) throw error;
    });
});
