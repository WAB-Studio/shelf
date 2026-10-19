// M16 (RNP-03, RNP-05): `loadGoalForm(goalId, month?)` reads what the four
// form pages draw of one goal, in one goals transaction and one statement.
//
// The shape it owes, field for field as `loadGoal` names them:
//   name, horizon, createdAt, archivedAt, endedOn, measureUnit, phases;
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
  month?: { month: string; past: boolean } | null;
  tasks?: FormTask[];
};
type LoadGoalForm = (goalId: string, month?: string) => Promise<GoalForm | null>;

let session: typeof import("@/lib/session");
let goalQueries: GoalQueries;
let loadGoalForm: LoadGoalForm;
let me: Person;
let other: Person;
let myGoal: string;
let otherGoal: string;
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

async function plantPhase(owner: string, goalId: string, aim: string, startsOn: string, endsOn: string): Promise<void> {
  await admin`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${owner}, ${goalId}, ${aim}, ${startsOn}::date, ${endsOn}::date)`;
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

  ids.parent = await plantTask(me.id, myGoal, "Padre del mes", { plannedMonth: month });
  ids.childA = await plantTask(me.id, myGoal, "Hija A", { parentId: ids.parent }, 30);
  ids.childB = await plantTask(me.id, myGoal, "Hija B", { parentId: ids.parent }, 45);
  ids.single = await plantTask(me.id, myGoal, "Suelta del mes", { plannedMonth: month }, 20);
  ids.laterParent = await plantTask(me.id, myGoal, "Padre del otro mes", { plannedMonth: later });
  ids.laterChild = await plantTask(me.id, myGoal, "Hija del otro mes", { parentId: ids.laterParent }, 15);
  ids.theirs = await plantTask(other.id, otherGoal, "Ajena del mes", { plannedMonth: month }, 10);
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
