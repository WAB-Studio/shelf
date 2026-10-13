// Drives the acts of a goal with no end (RP-99) through `actAs`: creating one, taking the end
// off and putting it back, and the month span of an endless goal. The admin pool only reads rows.
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
let today: string;

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

let oneOffs: typeof import("@/app/actions/one-offs");
let budgets: typeof import("@/app/actions/budgets");
let thisMonth: string;

function monthFrom(delta: number): string {
  const index = Number(thisMonth.slice(0, 4)) * 12 + Number(thisMonth.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  plan = await import("@/app/actions/plan");
  oneOffs = await import("@/app/actions/one-offs");
  budgets = await import("@/app/actions/budgets");
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  thisMonth = today.slice(0, 7);
  const runId = await openCheckRun(admin);
  [owner] = await createPeople(admin, runId, door, 1);
});

async function create(name: string, horizon?: string | null, parentId?: string): Promise<string> {
  const made = await as(owner, () => plan.createGoal({ name, horizon: horizon ?? null, parentId }));
  if (!made.ok) throw new Error(`createGoal: ${made.error}`);
  goalIds.push(made.goalId);
  return made.goalId;
}

const horizonOf = async (goalId: string) =>
  (await admin<{ h: string | null }[]>`select horizon::text as h from goals.goals where id = ${goalId}`)[0].h;

const day = (months: number) => `${monthFrom(months)}-01`;

test("createGoal without a horizon stores null", async () => {
  const goalId = await create("Leer");
  assert.equal(await horizonOf(goalId), null);
});

test("createGoal with no end inside one with an end is refused naming the one above; nothing is written", async () => {
  const above = await create("Con final", day(6));
  const result = await as(owner, () => plan.createGoal({ name: "Sin final dentro", horizon: null, parentId: above }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "tree.errors.endPastAbove");
  assert.equal(result.values?.name, "Con final");
  const [row] = await admin<{ n: number }[]>`select count(*)::int as n from goals.goals where parent_id = ${above}`;
  assert.equal(row.n, 0);
});

test("createGoal with an end inside one with no end lands", async () => {
  const above = await create("Sin final madre");
  const child = await as(owner, () => plan.createGoal({ name: "Con final dentro", horizon: day(3), parentId: above }));
  assert.equal(child.ok, true);
  if (child.ok) goalIds.push(child.goalId);
});

test("moveHorizon null takes the end off, and the goal leaves the ended", async () => {
  const goalId = await create("Quitar final", day(4));
  await admin`update goals.goals set horizon = ${today}::date - 3, created_at = now() - interval '10 days' where id = ${goalId}`;
  assert.deepEqual(await as(owner, () => plan.moveHorizon({ goalId, horizon: null })), { ok: true });
  assert.equal(await horizonOf(goalId), null);
  const [row] = await admin<{ open: boolean }[]>`
    select archived_at is null and (horizon is null or horizon > ${today}::date) as open from goals.goals where id = ${goalId}`;
  assert.equal(row.open, true);
});

test("moveHorizon gives an end to a goal holding an endless one: refused naming the inner goal; the end stays", async () => {
  const outer = await create("Madre sin final");
  await create("Hija sin final", null, outer);
  const result = await as(owner, () => plan.moveHorizon({ goalId: outer, horizon: day(5) }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "tree.errors.belowNoEnd");
  assert.equal(result.values?.name, "Hija sin final");
  assert.equal(await horizonOf(outer), null);
});

test("an endless goal takes a phase, a month amount and a task; the month past the span is refused", async () => {
  const goalId = await create("Abierta");
  const commitment = await as(owner, () =>
    plan.addCommitment({ goalId, name: "paginas", cadenceKind: "daily", satisfaction: "quantity", targetQuantity: 10, unit: "paginas" }),
  );
  assert.equal(commitment.ok, true);
  if (commitment.ok) commitmentIds.push(commitment.commitmentId);

  const phase = await as(owner, () => plan.addPhase({ goalId, aim: "una fase", startsOn: today, endsOn: day(2) }));
  assert.equal(phase.ok, true);
  assert.deepEqual(await as(owner, () => budgets.setMonthBudget({ goalId, month: monthFrom(11), amount: 5 })), { ok: true });
  assert.deepEqual(await as(owner, () => budgets.setMonthBudget({ goalId, month: monthFrom(12), amount: 5 })), {
    ok: false,
    error: "month.errors.outsideSpan",
  });
  assert.equal((await as(owner, () => oneOffs.createOneOff({ name: "tarea", day: null, goalId, plannedMonth: thisMonth }))).ok, true);
});

test("a subtask under a task of an endless goal lands", async () => {
  const goalId = await create("Con subtarea");
  const parent = await as(owner, () => oneOffs.createOneOff({ name: "madre", day: null, goalId, plannedMonth: thisMonth }));
  assert.equal(parent.ok, true);
  if (!parent.ok) return;
  const child = await as(owner, () => oneOffs.createOneOff({ name: "hija", day: null, parentId: parent.oneOffId }));
  assert.equal(child.ok, true);
});
