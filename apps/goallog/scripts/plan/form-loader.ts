// M16 (RNP-03, RNP-05): `loadGoalForm(goalId, month?)` reads what the four
// form pages draw of one goal, in one goals transaction and one statement.
//
// The shape it owes, field for field as `loadGoal` names them:
//   name, horizon, createdAt, archivedAt, endedOn, measureUnit, phases, commitments
//   (id, name, cadence, retiredAt, factDayCount: the goal's own, live and retired);
//   with a month ("YYYY-MM", as the page's `[mes]` carries it):
//     month — that month's entry: `month` ("YYYY-MM-01") and `past`, as in `loadGoal`'s `months`;
//     tasks — the month's tasks with their parent and children: id, parentId, name, plannedMonth,
//             day, estimate, doneOn, as in `loadGoal`'s `tasks`.
//   With no month: `month` null and no task.
// `null` for an unknown goal and for another person's.
//
// Statements are counted off the driver's own debug log on the app's own
// pool, reached as the pages reach it: `postgres` is answered through
// `Module._load`, so `db/client.ts` builds its real pool and the factory only
// adds the log.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Module from "node:module";
import { after, before, test } from "node:test";

import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, type Person } from "../mcp/lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

type Call = { query: string; parameters: unknown[] };
const wire: Call[] = [];

function installStubs(): void {
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "server-only") return {};
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (request === "next/cache") return { revalidatePath() {} };
    if (request === "postgres") {
      const real = originalLoad(request, parent, isMain) as typeof postgres;
      const factory = (target: string, options: Record<string, unknown> = {}) =>
        real(target, {
          ...options,
          debug: (_connection: number, query: string, parameters: unknown[]) => void wire.push({ query, parameters }),
        });
      return Object.assign(factory, real, { default: factory });
    }
    return originalLoad(request, parent, isMain);
  };
}

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

type GoalQueries = typeof import("@/lib/queries/goal");
type FormTask = {
  id: string;
  parentId: string | null;
  name: string;
  plannedMonth: string | null;
  day: string | null;
  estimate: number | null;
  doneOn: string | null;
};
type GoalForm = {
  name: string;
  horizon: string | null;
  createdAt: string;
  archivedAt: string | null;
  endedOn: string | null;
  measureUnit: string | null;
  phases: unknown[];
  commitments: unknown[];
  month?: { month: string; past: boolean } | null;
  tasks?: FormTask[];
};
type LoadGoalForm = (goalId: string, month?: string, today?: string) => Promise<GoalForm | null>;

let session: typeof import("@/lib/session");
let goalQueries: GoalQueries;
let loadGoalForm: LoadGoalForm;
let me: Person;
let other: Person;
let myGoal: string;
let otherGoal: string;
let siblingGoal: string; // a second goal of the same person, with its own phase, commitment and tasks
let month: string; // YYYY-MM, next month: inside the span and not past
const ids: Record<string, string> = {};

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;

function monthAfter(yyyyMm: string, months: number): string {
  const [year, m] = yyyyMm.split("-").map(Number);
  const index = year * 12 + (m - 1) + months;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

async function plantGoal(owner: string, name: string): Promise<string> {
  const horizon = new Date(Date.now() + 150 * 86_400_000).toISOString().slice(0, 10);
  const [row] = await admin<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, position)
    values (${owner}, ${name}, ${horizon}, 'Medida', 'min', 980) returning id`;
  return row.id;
}

type GoalOptions = { parentId?: string; createdDaysAgo?: number; horizonDays?: number; unit?: string | null; archived?: boolean };

async function plantGoalWith(owner: string, name: string, options: GoalOptions): Promise<string> {
  const horizon = new Date(Date.now() + (options.horizonDays ?? 150) * 86_400_000).toISOString().slice(0, 10);
  const unit = options.unit === undefined ? "min" : options.unit;
  const [row] = await admin<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, position, parent_id, created_at, archived_at)
    values (${owner}, ${name}, ${horizon}, ${unit === null ? null : "Medida"}, ${unit}, 970,
            ${options.parentId ?? null}, now() - ${`${options.createdDaysAgo ?? 0} days`}::interval,
            ${options.archived ? new Date() : null})
    returning id`;
  return row.id;
}

async function plantPhase(owner: string, goalId: string, aim: string, startsOn: string, endsOn: string): Promise<void> {
  await admin`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${owner}, ${goalId}, ${aim}, ${startsOn}::date, ${endsOn}::date)`;
}

async function plantCommitment(owner: string, goalId: string, name: string, retired: boolean): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at, retired_at)
    values (${owner}, ${goalId}, ${name}, 'daily', 'tap', now() - interval '10 days', ${retired ? new Date() : null})
    returning id`;
  return row.id;
}

async function plantTask(
  owner: string,
  goalId: string,
  name: string,
  place: { plannedMonth: string } | { parentId: string },
  estimate: number | null = null,
): Promise<string> {
  const [row] =
    "plannedMonth" in place
      ? await admin<{ id: string }[]>`
          insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
          values (${owner}, ${goalId}, ${name}, ${`${place.plannedMonth}-01`}::date, ${estimate}) returning id`
      : await admin<{ id: string }[]>`
          insert into goals.one_offs (user_id, goal_id, name, parent_id, estimate)
          values (${owner}, ${goalId}, ${name}, ${place.parentId}, ${estimate}) returning id`;
  return row.id;
}

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  goalQueries = await import("@/lib/queries/goal");
  loadGoalForm = (goalQueries as unknown as { loadGoalForm: LoadGoalForm }).loadGoalForm;
  const { todayInZone } = await import("@/lib/zone");
  month = monthAfter(todayInZone().slice(0, 7), 1);
  const later = monthAfter(month, 1);

  const runId = await openCheckRun(admin);
  [me, other] = await createPeople(admin, runId, door, 2);
  myGoal = await plantGoal(me.id, `form-loader mine ${randomUUID()}`);
  otherGoal = await plantGoal(other.id, `form-loader theirs ${randomUUID()}`);

  await plantPhase(me.id, myGoal, "Base", `${month}-01`, `${month}-20`);
  await plantPhase(me.id, myGoal, "Cierre", `${later}-01`, `${later}-25`);
  await plantPhase(other.id, otherGoal, "Ajena", `${month}-01`, `${month}-20`);

  ids.live = await plantCommitment(me.id, myGoal, "Viva", false);
  ids.retired = await plantCommitment(me.id, myGoal, "Retirada", true);
  for (const day of ["2026-01-05", "2026-01-06"]) {
    await admin`
      insert into goals.facts (user_id, commitment_id, goal_id, day)
      values (${me.id}, ${ids.live}, ${myGoal}, ${day}::date)`;
  }
  ids.parent = await plantTask(me.id, myGoal, "Padre del mes", { plannedMonth: month });
  ids.childA = await plantTask(me.id, myGoal, "Hija A", { parentId: ids.parent }, 30);
  ids.childB = await plantTask(me.id, myGoal, "Hija B", { parentId: ids.parent }, 45);
  ids.single = await plantTask(me.id, myGoal, "Suelta del mes", { plannedMonth: month }, 20);
  ids.laterParent = await plantTask(me.id, myGoal, "Padre del otro mes", { plannedMonth: later });
  ids.laterChild = await plantTask(me.id, myGoal, "Hija del otro mes", { parentId: ids.laterParent }, 15);
  ids.theirs = await plantTask(other.id, otherGoal, "Ajena del mes", { plannedMonth: month }, 10);

  siblingGoal = await plantGoal(me.id, `form-loader sibling ${randomUUID()}`);
  await plantPhase(me.id, siblingGoal, "Hermana", `${month}-01`, `${month}-20`);
  ids.siblingCommitment = await plantCommitment(me.id, siblingGoal, "De la hermana", false);
  ids.siblingParent = await plantTask(me.id, siblingGoal, "Padre de la hermana", { plannedMonth: month });
  ids.siblingChild = await plantTask(me.id, siblingGoal, "Hija de la hermana", { parentId: ids.siblingParent }, 5);
  ids.siblingSingle = await plantTask(me.id, siblingGoal, "Suelta de la hermana", { plannedMonth: month }, 7);
});

after(async () => {
  try {
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

const as = <T>(person: Person, read: () => Promise<T>) => session.actAs(asResolved(person), read);

const pickTask = (task: FormTask): FormTask => ({
  id: task.id,
  parentId: task.parentId,
  name: task.name,
  plannedMonth: task.plannedMonth,
  day: task.day,
  estimate: task.estimate,
  doneOn: task.doneOn,
});

test("form loader shape: the goal's fields and phases equal loadGoal's", async () => {
  const [form, view] = await as(me, () => Promise.all([loadGoalForm(myGoal, month), goalQueries.loadGoal(myGoal)]));
  assert.ok(view, "loadGoal read nothing: the fixture is broken");
  assert.ok(form, "loadGoalForm read nothing for the person's own goal");
  for (const field of ["name", "horizon", "createdAt", "archivedAt", "endedOn", "measureUnit"] as const) {
    assert.deepEqual(form[field], view[field], field);
  }
  assert.equal(view.phases.length, 2, "the fixture's two phases");
  assert.deepEqual(form.phases, view.phases);
});

test("form loader shape: the goal's commitments equal loadGoal's, with their retirement and fact days", async () => {
  const [form, view] = await as(me, () => Promise.all([loadGoalForm(myGoal, month), goalQueries.loadGoal(myGoal)]));
  assert.ok(view && form);
  assert.equal(view.commitments.length, 2, "the fixture's two commitments");
  assert.deepEqual(form.commitments, view.commitments);
  const live = form.commitments.find((c) => (c as { id: string }).id === ids.live) as { factDayCount: number };
  const retired = form.commitments.find((c) => (c as { id: string }).id === ids.retired) as { retiredAt: string | null };
  assert.equal(live.factDayCount, 2);
  assert.notEqual(retired.retiredAt, null);
});

test("form loader shape: with a month, that month's entry and its tasks with their parent and children", async () => {
  const [form, view] = await as(me, () => Promise.all([loadGoalForm(myGoal, month), goalQueries.loadGoal(myGoal)]));
  assert.ok(view && form);
  const entry = view.months.find((row) => row.month === `${month}-01`);
  assert.ok(entry, "loadGoal has no entry for the month: the fixture is broken");
  assert.ok(form.month, "no month entry");
  assert.deepEqual({ month: form.month.month, past: form.month.past }, { month: entry.month, past: entry.past });

  const owed = [ids.parent, ids.childA, ids.childB, ids.single];
  const expected = view.tasks
    .filter((task) => owed.includes(task.id))
    .map(pickTask)
    .sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(expected.length, owed.length, "loadGoal lacks a fixture task");
  const got = (form.tasks ?? []).map(pickTask).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(got, expected);
});

test("form loader shape: with no month, the goal alone", async () => {
  const form = await as(me, () => loadGoalForm(myGoal));
  assert.ok(form);
  assert.equal(form.name.startsWith("form-loader mine"), true);
  assert.equal(form.month ?? null, null);
  assert.equal((form.tasks ?? []).length, 0);
});

type Counted = { transactions: number; statements: number; settles: Call[] };

function count(calls: Call[]): Counted {
  const text = (call: Call) => call.query.replace(/\s+/g, " ").trim().toLowerCase();
  const typeFetch = (call: Call) => text(call).startsWith("select b.oid, b.typarray from pg_catalog.pg_type");
  const bracket = (call: Call) => /^(begin|commit|rollback)\b/.test(text(call));
  return {
    transactions: calls.filter((call) => /^begin\b/.test(text(call))).length,
    statements: calls.filter((call) => !bracket(call) && !typeFetch(call)).length,
    settles: calls.filter((call) => text(call).includes("set_config('request.jwt.claims'")),
  };
}

async function countedRead(read: () => Promise<unknown>): Promise<Counted> {
  await as(me, read); // warms the pool: no connection opens inside the count
  wire.length = 0;
  await as(me, read);
  return count([...wire]);
}

const shapes: [string, () => Promise<unknown>][] = [
  ["with a month", () => loadGoalForm(myGoal, month)],
  ["with no month", () => loadGoalForm(myGoal)],
];
for (const [label, read] of shapes) {
  test(`one statement: loadGoalForm ${label} opens one goals transaction and sends one statement after its settle`, async () => {
    const counted = await countedRead(read);
    assert.equal(counted.transactions, 1, "transactions");
    assert.equal(counted.settles.length, 1, "settles");
    const settle = counted.settles[0];
    const settledPath = `${settle.query} ${JSON.stringify(settle.parameters)}`;
    assert.match(settledPath, /goals, public/, "the one transaction is the goals door");
    assert.doesNotMatch(settledPath, /reading/, "a reading transaction");
    assert.equal(counted.statements, 2, "the settle and one statement");
  });
}

test("foreign goal: another person's goal reads null, and an unknown one too", async () => {
  const theirs = await as(other, () => loadGoalForm(otherGoal, month));
  assert.ok(theirs, "the owner reads their own goal: the id is real");
  assert.equal(await as(me, () => loadGoalForm(otherGoal, month)), null);
  assert.equal(await as(me, () => loadGoalForm(otherGoal)), null);
  assert.equal(await as(me, () => loadGoalForm(randomUUID(), month)), null);
});

const idsOf = (rows: unknown[]): string[] => rows.map((row) => (row as { id: string }).id).sort();

test("scoping: a goal's form holds its own phases, commitments and tasks, not its sibling's of the same person", async () => {
  const [mine, sibling] = await as(me, () => Promise.all([loadGoalForm(myGoal, month), loadGoalForm(siblingGoal, month)]));
  assert.ok(mine && sibling);
  assert.deepEqual(
    (mine.phases as { name: string }[]).map((phase) => phase.name).sort(),
    ["Base", "Cierre"],
  );
  assert.deepEqual(idsOf(mine.commitments), [ids.live, ids.retired].sort());
  assert.deepEqual(idsOf(mine.tasks ?? []), [ids.parent, ids.childA, ids.childB, ids.single].sort());

  assert.deepEqual((sibling.phases as { name: string }[]).map((phase) => phase.name), ["Hermana"]);
  assert.deepEqual(idsOf(sibling.commitments), [ids.siblingCommitment]);
  assert.deepEqual(idsOf(sibling.tasks ?? []), [ids.siblingParent, ids.siblingChild, ids.siblingSingle].sort());
});

test("the database owes loadGoalForm that a task planned in a month is never a child", async () => {
  await assert.rejects(
    admin`insert into goals.one_offs (user_id, goal_id, name, parent_id, planned_month)
          values (${me.id}, ${myGoal}, 'Hija con mes', ${ids.laterParent}, ${`${month}-01`}::date)`,
    /one_offs_child_has_no_month/,
  );
});

test("month shape: an impossible month answers as no month, never a database error", async () => {
  for (const bad of ["2026-13", "2026-00", "2026-1", "26-05", "2026-05-01", "junk"]) {
    const form = await as(me, () => loadGoalForm(myGoal, bad));
    assert.ok(form, bad);
    assert.equal(form.month, null, bad);
    assert.deepEqual(form.tasks ?? [], [], bad);
  }
});

test("id shape: an id that is no uuid reads null, never a database error", async () => {
  assert.equal(await as(me, () => loadGoalForm("not-a-uuid", month)), null);
  assert.equal(await as(me, () => loadGoalForm("", month)), null);
});

test("span: a month before the goal opened or after its end draws no month entry", async () => {
  const before = await as(me, () => loadGoalForm(myGoal, monthAfter(month, -24)));
  const after = await as(me, () => loadGoalForm(myGoal, monthAfter(month, 12)));
  assert.ok(before && after);
  assert.equal(before.month, null);
  assert.equal(after.month, null);
  const inside = await as(me, () => loadGoalForm(myGoal, month));
  assert.equal(inside?.month?.month, `${month}-01`);
});

test("past: the month holding today is not past, the one before it is", async () => {
  const { todayInZone } = await import("@/lib/zone");
  const current = todayInZone().slice(0, 7);
  const midNext = `${month}-10`;
  const asNext = await as(me, () => loadGoalForm(myGoal, month, midNext));
  const asCurrent = await as(me, () => loadGoalForm(myGoal, current, midNext));
  assert.deepEqual(asNext?.month, { month: `${month}-01`, past: false });
  assert.deepEqual(asCurrent?.month, { month: `${current}-01`, past: true });
});

test("endedOn: null the day before the horizon, the day before the horizon from the horizon on", async () => {
  const first = await as(me, () => loadGoalForm(myGoal));
  assert.ok(first?.horizon);
  const shift = (day: string, days: number): string =>
    new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const horizon = first.horizon;
  const eve = shift(horizon, -1);
  assert.equal((await as(me, () => loadGoalForm(myGoal, undefined, eve)))?.endedOn, null);
  assert.equal((await as(me, () => loadGoalForm(myGoal, undefined, horizon)))?.endedOn, eve);
  assert.equal((await as(me, () => loadGoalForm(myGoal, undefined, shift(horizon, 3))))?.endedOn, eve);
});

test("a goal holding open goals takes its unit and the start of its span from them", async () => {
  const holder = await plantGoalWith(me.id, `form-loader holder ${randomUUID()}`, { unit: null });
  await plantGoalWith(me.id, `form-loader held ${randomUUID()}`, {
    parentId: holder,
    unit: "km",
    createdDaysAgo: 70,
    horizonDays: 100,
  });
  const { todayInZone } = await import("@/lib/zone");
  const heldOpened = new Date(Date.now() - 70 * 86_400_000).toISOString().slice(0, 7);
  assert.notEqual(heldOpened, todayInZone().slice(0, 7), "the fixture must open the child in an earlier month");
  const form = await as(me, () => loadGoalForm(holder, heldOpened));
  assert.ok(form);
  assert.equal(form.measureUnit, "km");
  assert.equal(form.month?.month, `${heldOpened}-01`);
});

test("a goal holding only archived goals keeps its own unit and its own span", async () => {
  const holder = await plantGoalWith(me.id, `form-loader archived-holder ${randomUUID()}`, { unit: null });
  await plantGoalWith(me.id, `form-loader archived-held ${randomUUID()}`, {
    parentId: holder,
    unit: "km",
    createdDaysAgo: 70,
    horizonDays: 100,
    archived: true,
  });
  const heldOpened = new Date(Date.now() - 70 * 86_400_000).toISOString().slice(0, 7);
  const form = await as(me, () => loadGoalForm(holder, heldOpened));
  assert.ok(form);
  assert.equal(form.measureUnit, null);
  assert.equal(form.month, null);
});

test("the database owes loadGoalForm one fact a day per commitment and one per task", async () => {
  await assert.rejects(
    admin`insert into goals.facts (user_id, commitment_id, goal_id, day)
          values (${me.id}, ${ids.live}, ${myGoal}, '2026-01-05'::date)`,
    /facts_commitment_day_unique/,
  );
  await admin`insert into goals.facts (user_id, one_off_id, goal_id, day) values (${me.id}, ${ids.single}, ${myGoal}, '2026-02-01'::date)`;
  await assert.rejects(
    admin`insert into goals.facts (user_id, one_off_id, goal_id, day)
          values (${me.id}, ${ids.single}, ${myGoal}, '2026-02-02'::date)`,
    /facts_one_off_unique/,
  );
  await admin`delete from goals.facts where one_off_id = ${ids.single}`;
});
