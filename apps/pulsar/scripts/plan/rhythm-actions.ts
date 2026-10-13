// Drives `setRhythm` and `dismissPlanNotice` (`app/actions/roadmap.ts`,
// RP-50, RP-52) as two people through `actAs`; the admin pool only plants
// what no action writes (a month's amount, a task's month, a fact) and reads
// rows back. Statements are counted off the wire, `begin`/`commit` netted out.
import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, test } from "node:test";

import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "../mcp/lib/people";
import { plannedOf } from "@/lib/plan/months";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

const admin = adminSql();
const wire: string[] = [];
const door = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 1,
  debug: (_connection: number, query: string) => void wire.push(query),
});
(globalThis as unknown as { sql: unknown }).sql = door;

const revalidated: { path: string; type?: string }[] = [];

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (request === "next/cache") {
      return { revalidatePath: (path: string, type?: string) => void revalidated.push({ path, type }) };
    }
    return originalLoad(request, parent, isMain);
  };
}

let session: typeof import("@/lib/session");
let roadmap: typeof import("@/app/actions/roadmap");
let plan: typeof import("@/app/actions/plan");
let owner: Person;
let stranger: Person;
let today: string;
let thisMonth: string;

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const as = <T>(person: Person, fn: () => Promise<T>) => session.actAs(asResolved(person), fn);

// "YYYY-MM" `delta` months from the one `day` sits in.
function monthFrom(day: string, delta: number): string {
  const index = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const horizonOf = () => `${monthFrom(today, 3)}-01`;

async function goal(person: Person, name: string, measured: boolean, unit = "minutos"): Promise<string> {
  const horizon = horizonOf();
  const created = await as(person, () => plan.createGoal({ name, horizon }));
  if (!created.ok) throw new Error(`createGoal: ${created.error}`);
  if (measured) {
    const commitment = await as(person, () =>
      plan.addCommitment({
        goalId: created.goalId,
        name: "minutos",
        cadenceKind: "daily",
        satisfaction: "quantity",
        targetQuantity: 10,
        unit,
      }),
    );
    if (!commitment.ok) throw new Error(`addCommitment: ${commitment.error}`);
  }
  return created.goalId;
}

async function openedTwoMonthsAgo(goalId: string): Promise<void> {
  await admin`update goals.goals set created_at = ${`${monthFrom(today, -2)}-15T12:00:00Z`} where id = ${goalId}`;
}

async function budgets(goalId: string): Promise<{ month: string; amount: number }[]> {
  const rows = await admin<{ month: string; amount: number }[]>`
    select month::text as month, amount from goals.month_budgets where goal_id = ${goalId} order by month`;
  return rows.map(({ month, amount }) => ({ month, amount }));
}

async function rhythmOf(goalId: string): Promise<number | null> {
  const [row] = await admin<{ rhythm: number | null }[]>`select rhythm from goals.goals where id = ${goalId}`;
  return row.rhythm;
}

async function task(person: Person, goalId: string, name: string, month: string | null): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${person.id}, ${goalId}, ${name}, ${month === null ? null : `${month}-01`}) returning id`;
  return row.id;
}

async function monthOfTask(id: string): Promise<string | null> {
  const [row] = await admin<{ m: string | null }[]>`select planned_month::text as m from goals.one_offs where id = ${id}`;
  return row.m;
}

async function statementsOf(read: () => Promise<unknown>): Promise<number> {
  wire.length = 0;
  await read();
  return wire.filter((query) => !/^\s*(begin|commit)\s*$/i.test(query)).length;
}

const goalIds: string[] = [];

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  roadmap = await import("@/app/actions/roadmap");
  plan = await import("@/app/actions/plan");
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  thisMonth = today.slice(0, 7);
  const runId = await openCheckRun(admin);
  [owner, stranger] = await createPeople(admin, runId, door, 2);
});

after(async () => {
  try {
    if (goalIds.length > 0) await admin`delete from goals.goals where id in ${admin(goalIds)}`;
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

test("setRhythm: a rhythm lands and revalidates the goal as a layout and Hoy", async () => {
  const goalId = await goal(owner, "ritmo", true);
  goalIds.push(goalId);
  revalidated.length = 0;
  const result = await as(owner, () => roadmap.setRhythm({ goalId, amount: 720 }));
  assert.deepEqual(result, { ok: true });
  assert.equal(await rhythmOf(goalId), 720);
  assert.deepEqual(revalidated, [{ path: `/metas/${goalId}`, type: "layout" }, { path: "/", type: undefined }]);
});

test("setRhythm: changing it writes the old one's share into closed months with no amount and leaves the others", async () => {
  const goalId = await goal(owner, "cambio", true);
  goalIds.push(goalId);
  await openedTwoMonthsAgo(goalId);
  const set = await as(owner, () => roadmap.setRhythm({ goalId, amount: 720 }));
  assert.deepEqual(set, { ok: true });
  // The first rhythm has no old one to write.
  assert.deepEqual(await budgets(goalId), []);

  await admin`insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${owner.id}, ${goalId}, ${`${monthFrom(today, -1)}-01`}, 55)`;
  const changed = await as(owner, () => roadmap.setRhythm({ goalId, amount: 840 }));
  assert.deepEqual(changed, { ok: true });
  assert.equal(await rhythmOf(goalId), 840);
  // Opened on the 15th: the first month keeps the share it was lived against (RP-74).
  const first = `${monthFrom(today, -2)}-01`;
  const share = plannedOf(first, { budgets: [], rhythm: 720, openedOn: `${monthFrom(today, -2)}-15`, horizon: horizonOf() });
  assert.ok(share !== null && share < 720);
  assert.deepEqual(await budgets(goalId), [
    { month: first, amount: share },
    { month: `${monthFrom(today, -1)}-01`, amount: 55 },
  ]);
  // The open month and the ones after it stay untouched.
  assert.ok(!(await budgets(goalId)).some((row) => row.month >= `${thisMonth}-01`));
});

test("setRhythm: a goal with no measure, an archived one and an ended one are refused with their keys", async () => {
  const unmeasured = await goal(owner, "sin medida", false);
  const archived = await goal(owner, "archivada", true);
  const ended = await goal(owner, "terminada", true);
  goalIds.push(unmeasured, archived, ended);
  const closed = await as(owner, () => plan.archiveGoal({ goalId: archived }));
  assert.ok(closed.ok);
  await admin`update goals.goals set horizon = ${today} where id = ${ended}`;

  assert.deepEqual(await as(owner, () => roadmap.setRhythm({ goalId: unmeasured, amount: 60 })), {
    ok: false,
    error: "roadmap.errors.rhythmNoMeasure",
  });
  for (const goalId of [archived, ended]) {
    assert.deepEqual(await as(owner, () => roadmap.setRhythm({ goalId, amount: 60 })), {
      ok: false,
      error: "month.errors.closed",
    });
    assert.equal(await rhythmOf(goalId), null);
  }
});

test("setRhythm: a goal measured in km receives a rhythm; minutes and «Minutos » land", async () => {
  const km = await goal(owner, "kilometros", true, "km");
  const upper = await goal(owner, "mayusculas", true, "Minutos ");
  goalIds.push(km, upper);
  assert.deepEqual(await as(owner, () => roadmap.setRhythm({ goalId: km, amount: 40 })), { ok: true });
  assert.equal(await rhythmOf(km), 40);
  assert.deepEqual(await as(owner, () => roadmap.setRhythm({ goalId: upper, amount: 60 })), { ok: true });
  assert.equal(await rhythmOf(upper), 60);
});

test("setRhythm: 0 and 44 641 are refused, 1 and 44 640 land", async () => {
  const goalId = await goal(owner, "rango", true);
  goalIds.push(goalId);
  for (const amount of [0, 44_641, 1.5, -3]) {
    assert.deepEqual(await as(owner, () => roadmap.setRhythm({ goalId, amount })), {
      ok: false,
      error: "roadmap.errors.rhythmRange",
    });
    assert.equal(await rhythmOf(goalId), null);
  }
  for (const amount of [1, 44_640]) {
    assert.deepEqual(await as(owner, () => roadmap.setRhythm({ goalId, amount })), { ok: true });
    assert.equal(await rhythmOf(goalId), amount);
  }
});

test("setRhythm: 44 641 lands in km, and a first rhythm in km leaves fixed tasks and plan_seen alone", async () => {
  const km = await goal(owner, "kilometros tope", true, "km");
  goalIds.push(km);
  const next = monthFrom(today, 1);
  const fixed = [await task(owner, km, "fija uno", next), await task(owner, km, "fija dos", next)];
  assert.deepEqual(await as(owner, () => roadmap.setRhythm({ goalId: km, amount: 44_641 })), { ok: true });
  assert.equal(await rhythmOf(km), 44_641);
  for (const id of fixed) assert.equal(await monthOfTask(id), `${next}-01`);
  const [row] = await admin<{ seen: string | null }[]>`select plan_seen::text as seen from goals.goals where id = ${km}`;
  assert.equal(row.seen, null);
});

test("setRhythm: a goal with goals inside is refused with holderNoRhythm in any unit", async () => {
  const holder = await goal(owner, "madre km", true, "km");
  goalIds.push(holder);
  const child = await as(owner, () => plan.createGoal({ name: "hija", horizon: horizonOf(), parentId: holder }));
  assert.ok(child.ok);
  goalIds.push(child.goalId);
  assert.deepEqual(await as(owner, () => roadmap.setRhythm({ goalId: holder, amount: 5 })), {
    ok: false,
    error: "tree.errors.holderNoRhythm",
  });
});

test("setRhythm: past a million, km says the plain range and minutes say hours", async () => {
  const km = await goal(owner, "kilometros tope alto", true, "km");
  const min = await goal(owner, "minutos tope alto", true);
  goalIds.push(km, min);
  assert.deepEqual(await as(owner, () => roadmap.setRhythm({ goalId: km, amount: 1_000_001 })), {
    ok: false,
    error: "roadmap.errors.rhythmRangeAny",
  });
  assert.deepEqual(await as(owner, () => roadmap.setRhythm({ goalId: min, amount: 1_000_001 })), {
    ok: false,
    error: "roadmap.errors.rhythmRange",
  });
});

test("setRhythm: an input that is not an object is refused with a key, not thrown", async () => {
  for (const input of [undefined, null, "x"]) {
    assert.deepEqual(await as(owner, () => roadmap.setRhythm(input)), {
      ok: false,
      error: "month.errors.invalid",
    });
  }
});

test("setRhythm: another person's goal is refused and untouched", async () => {
  const goalId = await goal(owner, "ajena", true);
  goalIds.push(goalId);
  const result = await as(stranger, () => roadmap.setRhythm({ goalId, amount: 60 }));
  assert.deepEqual(result, { ok: false, error: "month.errors.notFound" });
  assert.equal(await rhythmOf(goalId), null);
});

test("setRhythm: the first rhythm frees the months of undone tasks and keeps those of done ones", async () => {
  const goalId = await goal(owner, "primer ritmo", true);
  goalIds.push(goalId);
  const next = monthFrom(today, 1);
  const undone = await task(owner, goalId, "sin hacer", next);
  const done = await task(owner, goalId, "hecha", next);
  const parent = await task(owner, goalId, "madre", next);
  const [child] = await admin<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, parent_id) values (${owner.id}, ${goalId}, 'hija', ${parent}) returning id`;
  await admin`insert into goals.facts (user_id, one_off_id, goal_id, day) values (${owner.id}, ${child.id}, ${goalId}, ${today})`;
  await admin`insert into goals.facts (user_id, one_off_id, goal_id, day) values (${owner.id}, ${done}, ${goalId}, ${today})`;

  const first = await as(owner, () => roadmap.setRhythm({ goalId, amount: 600 }));
  assert.deepEqual(first, { ok: true });
  assert.equal(await monthOfTask(undone), null);
  assert.equal(await monthOfTask(done), `${next}-01`);
  // A parent whose every child is done is done by them.
  assert.equal(await monthOfTask(parent), `${next}-01`);

  // A second rhythm is a change, not a first: a task fixed since keeps its month.
  await admin`update goals.one_offs set planned_month = ${`${next}-01`} where id = ${undone}`;
  const second = await as(owner, () => roadmap.setRhythm({ goalId, amount: 660 }));
  assert.deepEqual(second, { ok: true });
  assert.equal(await monthOfTask(undone), `${next}-01`);
});

test("setRhythm: a rhythm on another goal frees nothing of this one", async () => {
  const a = await goal(owner, "una", true);
  const b = await goal(owner, "otra", true);
  goalIds.push(a, b);
  const id = await task(owner, a, "queda", monthFrom(today, 1));
  await as(owner, () => roadmap.setRhythm({ goalId: b, amount: 60 }));
  assert.equal(await monthOfTask(id), `${monthFrom(today, 1)}-01`);
});

test("dismissPlanNotice: dismissing last month reads back as that month, an older one never lowers it", async () => {
  const goalId = await goal(owner, "aviso", true);
  goalIds.push(goalId);
  const september = monthFrom(today, -1);
  const older = monthFrom(today, -3);
  revalidated.length = 0;
  assert.deepEqual(await as(owner, () => roadmap.dismissPlanNotice({ goalId, month: september })), { ok: true });
  const read = async () =>
    (await admin<{ seen: string | null }[]>`select plan_seen::text as seen from goals.goals where id = ${goalId}`)[0].seen;
  assert.equal(await read(), `${september}-01`);
  assert.deepEqual(revalidated, [{ path: "/", type: undefined }]);
  assert.deepEqual(await as(owner, () => roadmap.dismissPlanNotice({ goalId, month: older })), { ok: true });
  assert.equal(await read(), `${september}-01`);
});

test("dismissPlanNotice: another person's goal and a month not over are refused", async () => {
  const goalId = await goal(owner, "aviso ajeno", true);
  goalIds.push(goalId);
  assert.deepEqual(await as(stranger, () => roadmap.dismissPlanNotice({ goalId, month: monthFrom(today, -1) })), {
    ok: false,
    error: "month.errors.notFound",
  });
  assert.deepEqual(await as(owner, () => roadmap.dismissPlanNotice({ goalId, month: thisMonth })), {
    ok: false,
    error: "month.errors.monthInvalid",
  });
  const [row] = await admin<{ seen: string | null }[]>`select plan_seen::text as seen from goals.goals where id = ${goalId}`;
  assert.equal(row.seen, null);
});

const seenOf = async (id: string) =>
  (await admin<{ seen: string | null }[]>`select plan_seen::text as seen from goals.goals where id = ${id}`)[0].seen;

test("dismissPlanNotices: several goals read back as given, an older month never lowers one, one statement", async () => {
  const ids = [await goal(owner, "a1", true), await goal(owner, "a2", true), await goal(owner, "a3", true)];
  goalIds.push(...ids);
  const [september, august] = [monthFrom(today, -1), monthFrom(today, -2)];
  const months = [september, august, september];
  revalidated.length = 0;
  const notices = ids.map((goalId, i) => ({ goalId, month: months[i] }));
  assert.equal(await statementsOf(() => as(owner, () => roadmap.dismissPlanNotices({ notices }))), 2);
  assert.deepEqual(revalidated, [{ path: "/", type: undefined }]);
  assert.deepEqual(await Promise.all(ids.map(seenOf)), months.map((m) => `${m}-01`));
  const older = ids.map((goalId) => ({ goalId, month: monthFrom(today, -4) }));
  assert.deepEqual(await as(owner, () => roadmap.dismissPlanNotices({ notices: older })), { ok: true });
  assert.deepEqual(await Promise.all(ids.map(seenOf)), months.map((m) => `${m}-01`));
});

test("dismissPlanNotices: one goal sent twice keeps its latest month", async () => {
  const goalId = await goal(owner, "doble", true);
  goalIds.push(goalId);
  const [september, august] = [monthFrom(today, -1), monthFrom(today, -2)];
  const notices = [
    { goalId, month: september },
    { goalId, month: august },
  ];
  assert.deepEqual(await as(owner, () => roadmap.dismissPlanNotices({ notices })), { ok: true });
  assert.equal(await seenOf(goalId), `${september}-01`);
});

test("dismissPlanNotices: a stranger's goal among the owner's refuses all and writes nothing", async () => {
  const mine = [await goal(owner, "m1", true), await goal(owner, "m2", true)];
  const theirs = await goal(stranger, "ajena", true);
  goalIds.push(...mine, theirs);
  const month = monthFrom(today, -1);
  const notices = [mine[0], theirs, mine[1]].map((goalId) => ({ goalId, month }));
  revalidated.length = 0;
  assert.deepEqual(await as(owner, () => roadmap.dismissPlanNotices({ notices })), {
    ok: false,
    error: "month.errors.notFound",
  });
  assert.deepEqual(await Promise.all([...mine, theirs].map(seenOf)), [null, null, null]);
  assert.deepEqual(revalidated, []);
});

test("dismissPlanNotices: the current month, or an empty list, refuses before any write", async () => {
  const goalId = await goal(owner, "mes", true);
  goalIds.push(goalId);
  const notices = [
    { goalId, month: monthFrom(today, -1) },
    { goalId, month: thisMonth },
  ];
  assert.deepEqual(await as(owner, () => roadmap.dismissPlanNotices({ notices })), {
    ok: false,
    error: "month.errors.monthInvalid",
  });
  assert.equal(await seenOf(goalId), null);
  assert.equal((await as(owner, () => roadmap.dismissPlanNotices({ notices: [] }))).ok, false);
});

test("each act is one statement beside its settle", async () => {
  const goalId = await goal(owner, "viajes", true);
  goalIds.push(goalId);
  await as(owner, () => roadmap.setRhythm({ goalId, amount: 60 }));
  assert.equal(await statementsOf(() => as(owner, () => roadmap.setRhythm({ goalId, amount: 90 }))), 2);
  assert.equal(
    await statementsOf(() => as(owner, () => roadmap.dismissPlanNotice({ goalId, month: monthFrom(today, -1) }))),
    2,
  );
});

test("setRhythm: the first rhythm marks last month seen (RP-50)", async () => {
  const goalId = await goal(owner, "visto", true);
  goalIds.push(goalId);
  assert.equal(await seenOf(goalId), null);
  assert.deepEqual(await as(owner, () => roadmap.setRhythm({ goalId, amount: 600 })), { ok: true });
  assert.equal(await seenOf(goalId), `${monthFrom(today, -1)}-01`);
});

test("setRhythm: the first rhythm returns a pinned mother to the plan and leaves her child's row alone (RP-51)", async () => {
  const goalId = await goal(owner, "madre fijada", true);
  goalIds.push(goalId);
  const mother = await task(owner, goalId, "madre", monthFrom(today, 1));
  const [child] = await admin<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, parent_id)
    values (${owner.id}, ${goalId}, 'hija', ${mother}) returning id`;
  const rowOf = async () =>
    (await admin`select * from goals.one_offs where id = ${child.id}`)[0];
  const before = await rowOf();
  assert.deepEqual(await as(owner, () => roadmap.setRhythm({ goalId, amount: 600 })), { ok: true });
  assert.equal(await monthOfTask(mother), null);
  assert.deepEqual(await rowOf(), before);
});

test("setRhythm: a change freezes a whole closed month at the old rhythm and a first month opened on the 1st whole", async () => {
  const goalId = await goal(owner, "mes entero", true);
  goalIds.push(goalId);
  await admin`update goals.goals set created_at = ${`${monthFrom(today, -2)}-01T12:00:00Z`} where id = ${goalId}`;
  assert.deepEqual(await as(owner, () => roadmap.setRhythm({ goalId, amount: 600 })), { ok: true });
  assert.deepEqual(await as(owner, () => roadmap.setRhythm({ goalId, amount: 900 })), { ok: true });
  assert.deepEqual(await budgets(goalId), [
    { month: `${monthFrom(today, -2)}-01`, amount: 600 },
    { month: `${monthFrom(today, -1)}-01`, amount: 600 },
  ]);
});
