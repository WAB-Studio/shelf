// Drives `createOneOff`, `completeOneOff`, `scheduleOneOff` and `deleteOneOff`
// (`app/actions/one-offs.ts`, RP-30, RP-31) the way `budget-actions.ts` drives
// the month amounts: the actions imported as plain async functions,
// `server-only`, `next/headers` and `next/cache` stubbed before the first `@/`
// import, and the cookie `harness:mint-session` left standing is the session
// `getPerson()` reads. Every write goes through the actions, as
// `authenticated`; the pooler only reads rows back and deletes the fixtures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

import postgres from "postgres";

function laneNumber(): number {
  const raw = process.env.HARNESS_LANE?.trim();
  if (!raw) return 1;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`HARNESS_LANE must be a positive integer, not "${raw}"`);
  }
  return Number(raw);
}

type StoredCookie = { name: string; value: string };

function loadCookies(): StoredCookie[] {
  const file = resolve(process.cwd(), `private/session-${laneNumber()}.json`);
  let state: { cookies: StoredCookie[] };
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`no session at ${file} — run harness:mint-session first`);
  }
  if (state.cookies.length === 0) {
    throw new Error(`${file} carries no cookie — the mint did not land one`);
  }
  return state.cookies.map(({ name, value }) => ({ name, value }));
}

const revalidated: string[] = [];

function installStubs(cookies: StoredCookie[]): void {
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "server-only") return {};
    if (request === "next/headers") {
      return { cookies: async () => ({ getAll: () => cookies, set() {} }) };
    }
    if (request === "next/cache") {
      return { revalidatePath: (path: string) => void revalidated.push(path) };
    }
    return originalLoad(request, parent, isMain);
  };
}

type Actions = typeof import("@/app/actions/one-offs");
let actions: Actions;
let pgCode: typeof import("@/lib/db-error").pgCode;
let monthList: typeof import("@/lib/plan/carry").monthList;
let loadGoal: typeof import("@/lib/queries/goal").loadGoal;

// A throw names its SQLSTATE: a refusal the policy made instead of the action
// dies 42501, and the bare "Failed query" drizzle prints never says so.
async function call<K extends "createOneOff" | "completeOneOff" | "scheduleOneOff" | "deleteOneOff">(
  name: K,
  input: Parameters<Actions[K]>[0],
): Promise<Awaited<ReturnType<Actions[K]>>> {
  try {
    const action = actions[name] as (input: Parameters<Actions[K]>[0]) => ReturnType<Actions[K]>;
    return await action(input);
  } catch (error) {
    assert.fail(`${name} threw ${pgCode(error) ?? "without a code"}`);
  }
}

async function created(input: Parameters<Actions["createOneOff"]>[0]): Promise<string> {
  const result = await call("createOneOff", input);
  if (!result.ok) throw new Error(`createOneOff ${input.name}: ${result.error}`);
  return result.oneOffId;
}

// "YYYY-MM" `delta` months from the one `day` sits in.
function monthFrom(day: string, delta: number): string {
  const index = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });

const goalIds: string[] = [];
let today: string;
let thisMonth: string;
let measuredGoalId: string;
let unmeasuredGoalId: string;
let kmGoalId: string;
let archivedGoalId: string;
let endedGoalId: string;
// Planted while its goal was open, so a sub-task has a parent to be refused under.
let endedParentId: string;

type Row = {
  id: string;
  goal_id: string | null;
  parent_id: string | null;
  name: string;
  day: string | null;
  estimate: number | null;
  planned_month: string | null;
};

// The rows of one goal, as the pooler sees them.
async function rowsOf(goalId: string): Promise<Row[]> {
  const rows = await sql<Row[]>`
    select o.id, o.goal_id, o.parent_id, o.name, o.day::text as day, o.estimate,
           o.planned_month::text as planned_month
    from goals.one_offs o
    where o.goal_id = ${goalId}
    order by o.created_at, o.name`;
  return rows.map((row) => ({ ...row }));
}

async function factsOf(oneOffId: string): Promise<number> {
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from goals.facts where one_off_id = ${oneOffId}`;
  return count;
}

before(async () => {
  installStubs(loadCookies());
  const plan = await import("@/app/actions/plan");
  actions = await import("@/app/actions/one-offs");
  ({ pgCode } = await import("@/lib/db-error"));
  ({ monthList } = await import("@/lib/plan/carry"));
  ({ loadGoal } = await import("@/lib/queries/goal"));
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  thisMonth = today.slice(0, 7);
  // The 1st of the month after next: next month is the last one it plans.
  const horizon = `${monthFrom(today, 2)}-01`;

  async function goal(name: string, measured: boolean, unit = "minutos"): Promise<string> {
    const made = await plan.createGoal({ name, horizon });
    if (!made.ok) throw new Error(`createGoal: ${made.error}`);
    goalIds.push(made.goalId);
    if (measured) {
      const commitment = await plan.addCommitment({
        goalId: made.goalId,
        name: `RP-30 fixture: ${unit}`,
        cadenceKind: "daily",
        satisfaction: "quantity",
        targetQuantity: 10,
        unit,
      });
      if (!commitment.ok) throw new Error(`addCommitment: ${commitment.error}`);
    }
    return made.goalId;
  }

  measuredGoalId = await goal("RP-30 fixture: medida", true);
  unmeasuredGoalId = await goal("RP-30 fixture: sin medida", false);
  kmGoalId = await goal("RP-62 fixture: km", true, "km");
  archivedGoalId = await goal("RP-30 fixture: archivada", true);
  const archived = await plan.archiveGoal({ goalId: archivedGoalId });
  if (!archived.ok) throw new Error(`archiveGoal: ${archived.error}`);

  endedGoalId = await goal("RP-30 fixture: terminada", true);
  endedParentId = await created({ name: "RP-30 padre terminada", day: null, goalId: endedGoalId, plannedMonth: thisMonth });
  // No action moves a horizon onto today (`horizonRefusal` refuses it).
  await sql`update goals.goals set horizon = ${today} where id = ${endedGoalId}`;
});

after(async () => {
  // Cascades to each fixture's commitments, one-offs and their facts.
  if (goalIds.length > 0) await sql`delete from goals.goals where id in ${sql(goalIds)}`;
  await sql.end();
});

test("createOneOff: a month task with an estimate, a parent and two children land; the children take the parent's goal", async () => {
  revalidated.length = 0;
  const taskId = await created({
    name: "RP-31 leer el capítulo",
    day: null,
    goalId: measuredGoalId,
    plannedMonth: thisMonth,
    estimate: 90,
  });
  assert.ok(revalidated.includes(`/metas/${measuredGoalId}/meses/${thisMonth}`), revalidated.join(", "));

  const parentId = await created({ name: "RP-30 padre", day: null, goalId: measuredGoalId, plannedMonth: thisMonth });
  revalidated.length = 0;
  const firstId = await created({ name: "RP-30 hija uno", day: null, parentId, estimate: 30 });
  assert.ok(revalidated.includes(`/metas/${measuredGoalId}/meses/${thisMonth}`), revalidated.join(", "));
  const secondId = await created({ name: "RP-30 hija dos", day: null, parentId, estimate: 45 });

  const rows = await rowsOf(measuredGoalId);
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.deepEqual(
    [taskId, parentId, firstId, secondId].map((id) => {
      const row = byId.get(id)!;
      return [row.goal_id, row.parent_id, row.planned_month, row.estimate, row.day];
    }),
    [
      [measuredGoalId, null, `${thisMonth}-01`, 90, null],
      [measuredGoalId, null, `${thisMonth}-01`, null, null],
      [measuredGoalId, parentId, null, 30, null],
      [measuredGoalId, parentId, null, 45, null],
    ],
  );
});

test("createOneOff: a grandchild, and a child under a dated, an estimated or a done parent, are refused as parentInvalid", async () => {
  const parentId = await created({ name: "RP-30 abuela", day: null, goalId: measuredGoalId, plannedMonth: thisMonth });
  const childId = await created({ name: "RP-30 madre", day: null, parentId });
  const grandchild = await call("createOneOff", { name: "RP-30 nieta", day: null, parentId: childId });
  assert.deepEqual(grandchild, { ok: false, error: "month.errors.parentInvalid" });

  // A month task takes a day later; once it has one, it holds no sub-task.
  const datedId = await created({ name: "RP-30 fechada", day: null, goalId: measuredGoalId, plannedMonth: thisMonth });
  const scheduled = await call("scheduleOneOff", { oneOffId: datedId, day: today });
  assert.deepEqual(scheduled, { ok: true });
  const underDated = await call("createOneOff", { name: "RP-30 bajo fechada", day: null, parentId: datedId });
  assert.deepEqual(underDated, { ok: false, error: "month.errors.parentInvalid" });

  const estimatedId = await created({
    name: "RP-30 con tiempo",
    day: null,
    goalId: measuredGoalId,
    plannedMonth: thisMonth,
    estimate: 60,
  });
  const underEstimated = await call("createOneOff", { name: "RP-30 bajo con tiempo", day: null, parentId: estimatedId });
  assert.deepEqual(underEstimated, { ok: false, error: "month.errors.parentInvalid" });

  const doneId = await created({ name: "RP-30 hecha", day: null, goalId: measuredGoalId, plannedMonth: thisMonth });
  const completed = await call("completeOneOff", { oneOffId: doneId });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  const underDone = await call("createOneOff", { name: "RP-30 bajo hecha", day: null, parentId: doneId });
  assert.deepEqual(underDone, { ok: false, error: "month.errors.parentInvalid" });

  const names = (await rowsOf(measuredGoalId)).map((row) => row.name);
  for (const refused of ["RP-30 nieta", "RP-30 bajo fechada", "RP-30 bajo con tiempo", "RP-30 bajo hecha"]) {
    assert.ok(!names.includes(refused), `${refused} landed`);
  }
});

test("createOneOff: an estimate on a goal that measures nothing is refused as noMeasure, a sub-task's too", async () => {
  const own = await call("createOneOff", {
    name: "RP-30 sin medida",
    day: null,
    goalId: unmeasuredGoalId,
    plannedMonth: thisMonth,
    estimate: 30,
  });
  assert.deepEqual(own, { ok: false, error: "month.errors.noMeasure" });

  const parentId = await created({ name: "RP-30 padre sin medida", day: null, goalId: unmeasuredGoalId, plannedMonth: thisMonth });
  const child = await call("createOneOff", { name: "RP-30 hija sin medida", day: null, parentId, estimate: 30 });
  assert.deepEqual(child, { ok: false, error: "month.errors.noMeasure" });

  // Without an estimate the same goal takes both.
  await created({ name: "RP-30 hija sin tiempo", day: null, parentId });
  assert.deepEqual(
    (await rowsOf(unmeasuredGoalId)).map((row) => row.name),
    ["RP-30 padre sin medida", "RP-30 hija sin tiempo"],
  );
});

test("createOneOff: the month before the goal opened and the horizon's own month are outside the span; the last day's month lands", async () => {
  for (const month of [monthFrom(today, -1), monthFrom(today, 2)]) {
    const result = await call("createOneOff", {
      name: `RP-31 fuera ${month}`,
      day: null,
      goalId: measuredGoalId,
      plannedMonth: month,
    });
    assert.deepEqual(result, { ok: false, error: "month.errors.outsideSpan" });
  }
  await created({ name: "RP-31 último mes", day: null, goalId: measuredGoalId, plannedMonth: monthFrom(today, 1) });
  const names = (await rowsOf(measuredGoalId)).map((row) => row.name);
  assert.ok(names.includes("RP-31 último mes"));
  assert.ok(!names.some((name) => name.startsWith("RP-31 fuera")), names.join(", "));
});

test("createOneOff: a month and a day together are refused; an archived goal's month takes no task", async () => {
  const both = await call("createOneOff", {
    name: "RP-31 mes y día",
    day: today,
    goalId: measuredGoalId,
    plannedMonth: thisMonth,
  });
  assert.deepEqual(both, { ok: false, error: "month.errors.invalid" });

  const closed = await call("createOneOff", {
    name: "RP-31 archivada",
    day: null,
    goalId: archivedGoalId,
    plannedMonth: thisMonth,
  });
  assert.deepEqual(closed, { ok: false, error: "month.errors.closed" });
  assert.deepEqual(await rowsOf(archivedGoalId), []);
});

test("completeOneOff: a parent is refused and writes no fact; both children done leave it done in the month's list", async () => {
  const parentId = await created({ name: "RP-30 por hijas", day: null, goalId: measuredGoalId, plannedMonth: thisMonth });
  const firstId = await created({ name: "RP-30 por hijas uno", day: null, parentId, estimate: 20 });
  const secondId = await created({ name: "RP-30 por hijas dos", day: null, parentId, estimate: 25 });

  const parent = await call("completeOneOff", { oneOffId: parentId });
  assert.deepEqual(parent, { ok: false, error: "month.errors.parentIsDoneByChildren" });
  assert.equal(await factsOf(parentId), 0);

  const dated = await call("scheduleOneOff", { oneOffId: parentId, day: today });
  assert.deepEqual(dated, { ok: false, error: "month.errors.parentIsDoneByChildren" });

  for (const id of [firstId, secondId]) {
    const done = await call("completeOneOff", { oneOffId: id });
    assert.equal(done.ok, true, JSON.stringify(done));
  }
  assert.equal(await factsOf(parentId), 0);

  const view = await loadGoal(measuredGoalId, today);
  assert.ok(view, "loadGoal reads the goal");
  const { tasks } = view;
  assert.deepEqual(
    tasks.filter((task) => [firstId, secondId].includes(task.id)).map((task) => task.doneOn),
    [today, today],
  );
  const item = monthList(tasks, `${thisMonth}-01`, today).find((entry) => entry.task.id === parentId);
  assert.ok(item, "the parent is in its month's list");
  assert.equal(item.done, true);
  assert.equal(item.task.doneOn, null);
});

test("deleteOneOff: a parent with a done child is refused as parentHasDoneChild; one with none goes, children and all", async () => {
  const keptId = await created({ name: "RP-30 borrar con hecha", day: null, goalId: measuredGoalId, plannedMonth: thisMonth });
  const doneChildId = await created({ name: "RP-30 borrar hecha", day: null, parentId: keptId });
  const done = await call("completeOneOff", { oneOffId: doneChildId });
  assert.equal(done.ok, true, JSON.stringify(done));

  const refused = await call("deleteOneOff", { oneOffId: keptId });
  assert.deepEqual(refused, { ok: false, error: "month.errors.parentHasDoneChild" });
  assert.equal(await factsOf(doneChildId), 1);

  const goneId = await created({ name: "RP-30 borrar sin hecha", day: null, goalId: measuredGoalId, plannedMonth: thisMonth });
  const goneChildId = await created({ name: "RP-30 borrar pendiente", day: null, parentId: goneId });
  const deleted = await call("deleteOneOff", { oneOffId: goneId });
  assert.deepEqual(deleted, { ok: true });
  const ids = (await rowsOf(measuredGoalId)).map((row) => row.id);
  assert.ok(ids.includes(keptId) && ids.includes(doneChildId));
  assert.ok(!ids.includes(goneId) && !ids.includes(goneChildId));
});

test("createOneOff: an ended goal's month takes no task, and its parent takes no sub-task", async () => {
  const own = await call("createOneOff", {
    name: "RP-31 terminada",
    day: null,
    goalId: endedGoalId,
    plannedMonth: thisMonth,
  });
  assert.deepEqual(own, { ok: false, error: "month.errors.closed" });

  const child = await call("createOneOff", { name: "RP-30 hija terminada", day: null, parentId: endedParentId });
  assert.deepEqual(child, { ok: false, error: "month.errors.closed" });

  assert.deepEqual(
    (await rowsOf(endedGoalId)).map((row) => row.name),
    ["RP-30 padre terminada"],
  );
});

test("createOneOff: a sub-task under a goal's one-off with no planned month is refused as parentInvalid", async () => {
  const plainId = await created({ name: "RP-20 suelta de meta", day: null, goalId: measuredGoalId });
  const child = await call("createOneOff", { name: "RP-30 hija de suelta", day: null, parentId: plainId });
  assert.deepEqual(child, { ok: false, error: "month.errors.parentInvalid" });
  assert.equal((await rowsOf(measuredGoalId)).filter((row) => row.parent_id === plainId).length, 0);
});

test("createOneOff: a plain one-off of an archived goal still lands, as RP-20 wrote it", async () => {
  const id = await created({ name: "RP-20 suelta de archivada", day: null, goalId: archivedGoalId });
  const row = (await rowsOf(archivedGoalId)).find((r) => r.id === id)!;
  assert.deepEqual(
    [row.goal_id, row.parent_id, row.planned_month, row.estimate, row.day],
    [archivedGoalId, null, null, null, null],
  );
});

test("a goal that measures nothing: a month task with no estimate lands, and two sub-tasks under it take its goal", async () => {
  const parentId = await created({ name: "RP-30 sin medida padre", day: null, goalId: unmeasuredGoalId, plannedMonth: thisMonth });
  const firstId = await created({ name: "RP-30 sin medida uno", day: null, parentId });
  const secondId = await created({ name: "RP-30 sin medida dos", day: null, parentId });

  const byId = new Map((await rowsOf(unmeasuredGoalId)).map((row) => [row.id, row]));
  assert.deepEqual(
    [parentId, firstId, secondId].map((id) => {
      const row = byId.get(id)!;
      return [row.goal_id, row.parent_id, row.planned_month, row.estimate, row.day];
    }),
    [
      [unmeasuredGoalId, null, `${thisMonth}-01`, null, null],
      [unmeasuredGoalId, parentId, null, null, null],
      [unmeasuredGoalId, parentId, null, null, null],
    ],
  );
});

test("a goal that measures nothing: a sub-task with an estimate is refused as noMeasure and writes nothing", async () => {
  const parentId = await created({ name: "RP-30 sin medida estimada", day: null, goalId: unmeasuredGoalId, plannedMonth: thisMonth });
  const before = (await rowsOf(unmeasuredGoalId)).length;
  const child = await call("createOneOff", { name: "RP-30 sin medida con tiempo", day: null, parentId, estimate: 15 });
  assert.deepEqual(child, { ok: false, error: "month.errors.noMeasure" });
  assert.equal((await rowsOf(unmeasuredGoalId)).length, before);
});

test("a goal that measures nothing: the parent is refused completion; both children done leave it done in its month", async () => {
  const parentId = await created({ name: "RP-30 sin medida hecha", day: null, goalId: unmeasuredGoalId, plannedMonth: thisMonth });
  const firstId = await created({ name: "RP-30 sin medida hecha uno", day: null, parentId });
  const secondId = await created({ name: "RP-30 sin medida hecha dos", day: null, parentId });

  const refused = await call("completeOneOff", { oneOffId: parentId });
  assert.deepEqual(refused, { ok: false, error: "month.errors.parentIsDoneByChildren" });
  assert.equal(await factsOf(parentId), 0);

  const view = await loadGoal(unmeasuredGoalId, today);
  assert.ok(view, "loadGoal reads the goal");
  const listed = () => monthList(view.tasks, `${thisMonth}-01`, today).find((entry) => entry.task.id === parentId);
  assert.equal(listed()?.done, false);

  for (const id of [firstId, secondId]) {
    const done = await call("completeOneOff", { oneOffId: id });
    assert.equal(done.ok, true, JSON.stringify(done));
  }
  const after = await loadGoal(unmeasuredGoalId, today);
  assert.ok(after, "loadGoal reads the goal again");
  const item = monthList(after.tasks, `${thisMonth}-01`, today).find((entry) => entry.task.id === parentId);
  assert.ok(item, "the parent is in its month's list");
  assert.equal(item.done, true);
  assert.equal(item.task.doneOn, null);
});

test("a goal that measures nothing: a sub-task under another person's parent is refused by the action and by the policy", async () => {
  const lane = laneNumber();
  const memberEmail = `harness-member${lane === 1 ? "" : `-${lane}`}@example.invalid`;
  const ownEmail = `harness${lane === 1 ? "" : `-${lane}`}@example.invalid`;
  const [member] = await sql<{ id: string }[]>`select id from auth.users where email = ${memberEmail}`;
  const [own] = await sql<{ id: string }[]>`select id from auth.users where email = ${ownEmail}`;
  if (!member || !own) throw new Error("no lane identities — run harness:token for this lane");

  const [foreignGoal] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${member.id}, 'RP-30 ajena sin medida', ${`${monthFrom(today, 2)}-01`}) returning id`;
  try {
    const [foreignParent] = await sql<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month)
      values (${member.id}, ${foreignGoal.id}, 'RP-30 padre ajeno', ${`${thisMonth}-01`}) returning id`;

    // The action reads the parent under the person's policies: it is not there.
    const viaAction = await call("createOneOff", { name: "RP-30 hija ajena", day: null, parentId: foreignParent.id });
    assert.deepEqual(viaAction, { ok: false, error: "month.errors.notFound" });

    // Past the action, the insert policy alone must refuse: the parent is invisible to this person.
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: own.id, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        await tx`
          insert into goals.one_offs (user_id, goal_id, name, parent_id)
          values (${own.id}, ${foreignGoal.id}, 'RP-30 hija ajena directa', ${foreignParent.id})`;
      }),
      (error: unknown) => (error as { code?: string }).code === "42501",
    );

    const children = await sql`select id from goals.one_offs where parent_id = ${foreignParent.id}`;
    assert.equal(children.length, 0);
  } finally {
    await sql`delete from goals.goals where id = ${foreignGoal.id} and user_id = ${member.id}`;
  }
});

test("RP-62: a task of a goal measured in km is fixed to the month named, or to the current month", async () => {
  const next = monthFrom(today, 1);
  const named = await created({ name: "RP-62 km con mes", day: null, goalId: kmGoalId, plannedMonth: next });
  const bare = await created({ name: "RP-62 km sin mes", day: null, goalId: kmGoalId });
  const byId = new Map((await rowsOf(kmGoalId)).map((row) => [row.id, row]));
  assert.equal(byId.get(named)!.planned_month, `${next}-01`);
  assert.equal(byId.get(bare)!.planned_month, `${thisMonth}-01`);
});

test("RP-62: a task of a goal measured in minutes with no month stays in the plan, unpinned", async () => {
  const id = await created({ name: "RP-62 minutos sin mes", day: null, goalId: measuredGoalId });
  const row = (await rowsOf(measuredGoalId)).find((r) => r.id === id)!;
  assert.equal(row.planned_month, null);
});

test("RP-62: a sub-task of a km task keeps no month of its own", async () => {
  const parentId = await created({ name: "RP-62 km padre", day: null, goalId: kmGoalId });
  const childId = await created({ name: "RP-62 km hija", day: null, parentId });
  const row = (await rowsOf(kmGoalId)).find((r) => r.id === childId)!;
  assert.equal(row.planned_month, null);
  assert.equal(row.parent_id, parentId);
});

test("RP-62: a km goal not opened yet pins a task with no month to the first month of its span", async () => {
  const future = monthFrom(today, 1);
  await sql`update goals.goals set created_at = ${`${future}-05T12:00:00Z`} where id = ${kmGoalId}`;
  try {
    const id = await created({ name: "RP-62 km aún sin abrir", day: null, goalId: kmGoalId });
    const row = (await rowsOf(kmGoalId)).find((r) => r.id === id)!;
    assert.equal(row.planned_month, `${future}-01`);
  } finally {
    await sql`update goals.goals set created_at = now() where id = ${kmGoalId}`;
  }
});
