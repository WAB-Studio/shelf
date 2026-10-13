// Drives the acts of a habit with no goal (RP-100): making one, marking it, retiring it, and that
// no goal gains a fact or a measure from it. The admin pool only reads rows.
import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, test } from "node:test";

import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "../mcp/lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
(globalThis as unknown as { sql: unknown }).sql = door;

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (request === "next/cache") return { revalidatePath() {} };
    return originalLoad(request, parent, isMain);
  };
}

let session: typeof import("@/lib/session");
let plan: typeof import("@/app/actions/plan");
let owner: Person;

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const as = <T>(person: Person, fn: () => Promise<T>) => session.actAs(asResolved(person), fn);

const goalIds: string[] = [];
const commitmentIds: string[] = [];

after(async () => {
  try {
    if (commitmentIds.length > 0) await admin`delete from goals.commitments where id in ${admin(commitmentIds)}`;
    if (goalIds.length > 0) await admin`delete from goals.goals where id in ${admin(goalIds)}`;
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

let facts: typeof import("@/app/actions/facts");


before(async () => {
  installStubs();
  session = await import("@/lib/session");
  plan = await import("@/app/actions/plan");
  facts = await import("@/app/actions/facts");
  const runId = await openCheckRun(admin);
  [owner] = await createPeople(admin, runId, door, 1);
});

async function loose(satisfaction: "tap" | "quantity", unit = "min"): Promise<string> {
  const input =
    satisfaction === "tap"
      ? { name: "suelto", cadenceKind: "daily", satisfaction: "tap" }
      : { name: "suelto", cadenceKind: "daily", satisfaction: "quantity", targetQuantity: 10, unit };
  const made = await as(owner, () => plan.addCommitment(input as never));
  if (!made.ok) throw new Error(`addCommitment: ${made.error}`);
  commitmentIds.push(made.commitmentId);
  return made.commitmentId;
}

test("addCommitment without a goal stores goal_id null and changes no goal's measure", async () => {
  const goal = await as(owner, () => plan.createGoal({ name: "otra meta", horizon: null }));
  assert.equal(goal.ok, true);
  if (!goal.ok) return;
  goalIds.push(goal.goalId);
  const commitmentId = await loose("quantity", "min");
  const [row] = await admin<{ goal_id: string | null; unit: string | null }[]>`
    select goal_id, unit from goals.commitments where id = ${commitmentId}`;
  assert.equal(row.goal_id, null);
  assert.equal(row.unit, "min");
  const [measure] = await admin<{ measure_name: string | null; measure_unit: string | null }[]>`
    select measure_name, measure_unit from goals.goals where id = ${goal.goalId}`;
  assert.deepEqual(measure, { measure_name: null, measure_unit: null });
});

test("addCommitment without a goal keeps hours as minutes", async () => {
  const commitmentId = await loose("quantity", "horas");
  const [row] = await admin<{ unit: string; target: number }[]>`
    select unit, target_quantity as target from goals.commitments where id = ${commitmentId}`;
  assert.deepEqual(row, { unit: "minutos", target: 600 });
});

test("declareFact on a loose habit writes a fact with goal_id null, once a day", async () => {
  const commitmentId = await loose("tap");
  const first = await as(owner, () => facts.declareFact({ commitmentId }));
  assert.equal(first.ok, true);
  await as(owner, () => facts.declareFact({ commitmentId }));
  const rows = await admin<{ goal_id: string | null }[]>`select goal_id from goals.facts where commitment_id = ${commitmentId}`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].goal_id, null);
});

test("a loose quantity habit marked in min feeds no goal measured in min", async () => {
  const goal = await as(owner, () => plan.createGoal({ name: "meta en min", horizon: null }));
  assert.equal(goal.ok, true);
  if (!goal.ok) return;
  goalIds.push(goal.goalId);
  const own = await as(owner, () =>
    plan.addCommitment({ goalId: goal.goalId, name: "min", cadenceKind: "daily", satisfaction: "quantity", targetQuantity: 10, unit: "min" }),
  );
  assert.equal(own.ok, true);
  if (own.ok) commitmentIds.push(own.commitmentId);
  const commitmentId = await loose("quantity", "min");
  assert.equal((await as(owner, () => facts.declareFact({ commitmentId, quantity: 30 }))).ok, true);
  const [row] = await admin<{ n: number }[]>`select count(*)::int as n from goals.facts where goal_id = ${goal.goalId}`;
  assert.equal(row.n, 0);
});

test("retireCommitment retires a loose habit", async () => {
  const commitmentId = await loose("tap");
  assert.deepEqual(await as(owner, () => plan.retireCommitment({ commitmentId })), { ok: true });
  const [row] = await admin<{ retired: boolean }[]>`select retired_at is not null as retired from goals.commitments where id = ${commitmentId}`;
  assert.equal(row.retired, true);
});
