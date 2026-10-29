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

async function noteOf(commitmentId: string): Promise<string | null> {
  const [row] = await admin<{ note: string | null }[]>`select note from goals.commitments where id = ${commitmentId}`;
  return row.note;
}

test("a loose habit stores the note typed for it, trimmed; a blank one stores none (RP-100)", async () => {
  const made = await as(owner, () =>
    plan.addCommitment({ name: "bañarse", cadenceKind: "daily", satisfaction: "tap", note: "  agua tibia, después del gimnasio \n" }),
  );
  assert.equal(made.ok, true);
  if (!made.ok) return;
  commitmentIds.push(made.commitmentId);
  assert.equal(await noteOf(made.commitmentId), "agua tibia, después del gimnasio");

  const blank = await as(owner, () => plan.addCommitment({ name: "sin nota", cadenceKind: "daily", satisfaction: "tap", note: "   " }));
  assert.equal(blank.ok, true);
  if (!blank.ok) return;
  commitmentIds.push(blank.commitmentId);
  assert.equal(await noteOf(blank.commitmentId), null);
});

test("a habit under a goal carries no note: only a loose habit has one", async () => {
  const goal = await as(owner, () => plan.createGoal({ name: "meta con hábito", horizon: null }));
  assert.equal(goal.ok, true);
  if (!goal.ok) return;
  goalIds.push(goal.goalId);
  const made = await as(owner, () =>
    plan.addCommitment({ goalId: goal.goalId, name: "con meta", cadenceKind: "daily", satisfaction: "tap", note: "no debe quedar" }),
  );
  assert.equal(made.ok, true);
  if (!made.ok) return;
  commitmentIds.push(made.commitmentId);
  assert.equal(await noteOf(made.commitmentId), null);
});

test("a habit note of 2000 characters lands; of 2001 is refused by the action, nothing written", async () => {
  const before = (await admin<{ n: number }[]>`select count(*)::int as n from goals.commitments where user_id = ${owner.id}`)[0].n;
  const long = await as(owner, () =>
    plan.addCommitment({ name: "nota larga", cadenceKind: "daily", satisfaction: "tap", note: "a".repeat(2000) }),
  );
  assert.equal(long.ok, true);
  if (long.ok) commitmentIds.push(long.commitmentId);
  const tooLong = await as(owner, () =>
    plan.addCommitment({ name: "nota larguísima", cadenceKind: "daily", satisfaction: "tap", note: "a".repeat(2001) }),
  );
  assert.deepEqual(tooLong, { ok: false, error: "plan.errors.noteTooLong" });
  const after = (await admin<{ n: number }[]>`select count(*)::int as n from goals.commitments where user_id = ${owner.id}`)[0].n;
  assert.equal(after - before, 1);
});

test("a loose habit opens the day it was made: the day before is refused, that day is taken", async () => {
  const commitmentId = await loose("tap");
  await admin`update goals.commitments set created_at = now() - interval '3 days' where id = ${commitmentId}`;
  const { civilDateInZone } = await import("@/lib/zone");
  const dayAgo = (days: number) => civilDateInZone(new Date(Date.now() - days * 86_400_000));
  const before = await as(owner, () => facts.declareFact({ commitmentId, day: dayAgo(4) }));
  assert.equal(before.ok, false);
  const count = async () => (await admin<{ n: number }[]>`select count(*)::int as n from goals.facts where commitment_id = ${commitmentId}`)[0].n;
  assert.equal(await count(), 0);
  const opening = await as(owner, () => facts.declareFact({ commitmentId, day: dayAgo(3) }));
  assert.equal(opening.ok, true);
  assert.equal(await count(), 1);
});
