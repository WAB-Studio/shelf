// Proves RP-130's read (module 1020): `loadImportSnapshots` returns a snapshot of every open goal of the
// person whose name is among a draft's, in one statement, with every field of the type. Statements are
// counted off the wire, `begin`/`commit` netted out, as `page-statements.ts` counts them.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { sql } from "drizzle-orm";
import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "../mcp/lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";
import type { GoalSnapshot } from "@/lib/import/differences";

const admin = adminSql();
const wire: string[] = [];
const door = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 1,
  debug: (_connection: number, query: string) => void wire.push(query),
});
(globalThis as unknown as { sql: unknown }).sql = door;

let session: typeof import("@/lib/session");
let match: typeof import("@/lib/queries/import-match");
let mine: Person;
let other: Person;
const ids: Record<string, string> = {};

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const month = (offset: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
};

before(async () => {
  stubServerOnly();
  session = await import("@/lib/session");
  match = await import("@/lib/queries/import-match");
  const runId = await openCheckRun(admin);
  [mine, other] = await createPeople(admin, runId, door, 2);
  const horizon = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
  const goal = async (owner: Person, name: string, position: number, archived = false) => {
    const [row] = await admin<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, position, measure_name, measure_unit, rhythm, note, archived_at)
      values (${owner.id}, ${name}, ${horizon}, ${position}, 'Horas', 'h', 600, 'una nota',
              ${archived ? new Date() : null}) returning id`;
    return row.id;
  };
  ids.leer = await goal(mine, "Leer", 1);
  ids.ingles = await goal(mine, "Inglés", 2);
  ids.correr = await goal(mine, "Correr", 3);
  ids.archived = await goal(mine, "Pintar", 4, true);
  ids.stranger = await goal(other, "Cantar", 1);
  await goal(mine, "Sin nombre en la lista", 5);

  await admin`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${mine.id}, ${ids.leer}, ${month(1)}::date, 90)`;
  await admin`insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on) values (${mine.id}, ${ids.leer}, 'Base', ${month(0)}::date, ${month(2)}::date)`;
  // A quantity commitment in the measure's unit with a fact feeds the measure; a goal with none does not.
  const [qty] = await admin<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, position)
    values (${mine.id}, ${ids.ingles}, 'Estudiar', 'daily', 'quantity', 30, 'h', 1) returning id`;
  await admin`insert into goals.facts (user_id, commitment_id, goal_id, day, quantity) values (${mine.id}, ${qty.id}, ${ids.ingles}, ${month(0)}::date, 2)`;
  await admin`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_weekdays, satisfaction, position)
    values (${mine.id}, ${ids.leer}, 'Hojear', 'weekdays', '{1,3}', 'tap', 2)`;
  const [parent] = await admin<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, estimate, planned_month, in_plan, position)
    values (${mine.id}, ${ids.leer}, 'Capítulo', 60, ${month(1)}::date, true, 1) returning id`;
  const [kidDone] = await admin<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, parent_id, in_plan, position)
    values (${mine.id}, ${ids.leer}, 'Resumen', ${parent.id}, true, 2) returning id`;
  await admin`
    insert into goals.one_offs (user_id, goal_id, name, parent_id, in_plan, position)
    values (${mine.id}, ${ids.leer}, 'Fichas', ${parent.id}, true, 3)`;
  await admin`insert into goals.facts (user_id, one_off_id, goal_id, day) values (${mine.id}, ${kidDone.id}, ${ids.leer}, ${month(0)}::date)`;
});

after(async () => {
  try {
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

const names = ["Leer", "Inglés", "Correr", "Pintar", "Cantar"];
const load = (list = names) => session.actAs(asResolved(mine), () => match.loadImportSnapshots(list));
const named = (list: GoalSnapshot[], name: string) => list.find((g) => g.name === name)!;
const onTheWire = () => wire.filter((query) => !/^\s*(begin|commit)\s*$/i.test(query)).length;

test("three open goals come back, the archived and the other person's absent", async () => {
  const got = await load();
  assert.deepEqual(got.map((g) => g.name).sort(), ["Correr", "Inglés", "Leer"]);
  assert.equal(got.some((g) => g.id === ids.archived || g.id === ids.stranger), false);
});

test("one statement however many names: the settle and the read", async () => {
  await load();
  wire.length = 0;
  await load();
  assert.equal(onTheWire(), 2);
  wire.length = 0;
  await load(["Leer"]);
  assert.equal(onTheWire(), 2);
});

test("a name matches with accents counted and case and spaces not", async () => {
  assert.equal((await load([" leer  "])).length, 1);
  assert.equal((await load(["INGLÉS"])).length, 1);
  assert.equal((await load(["Ingles"])).length, 0);
  assert.equal((await load(["Inglés"])).length, 1);
  assert.deepEqual(await load([]), []);
});

test("every field of the type is read", async () => {
  const leer = named(await load(), "Leer");
  assert.equal(leer.id, ids.leer);
  assert.equal(typeof leer.horizon, "string");
  assert.equal(leer.note, "una nota");
  assert.deepEqual(leer.measure, { name: "Horas", unit: "h" });
  assert.equal(leer.rhythm, 600);
  assert.deepEqual(leer.months, [{ month: month(1), amount: 90 }]);
  assert.deepEqual(
    leer.phases.map(({ aim, startsOn, endsOn }) => ({ aim, startsOn, endsOn })),
    [{ aim: "Base", startsOn: month(0), endsOn: month(2) }],
  );
  assert.equal(leer.commitments.length, 1);
  assert.deepEqual(leer.commitments[0], {
    id: leer.commitments[0].id,
    name: "Hojear",
    cadence: { kind: "weekdays", weekdays: [1, 3], n: null },
    satisfaction: "tap",
    target: null,
    unit: null,
    hasFacts: false,
  });
});

test("measureFed and hasFacts follow the facts", async () => {
  const got = await load();
  const ingles = named(got, "Inglés");
  assert.equal(ingles.measureFed, true);
  assert.equal(ingles.commitments[0].hasFacts, true);
  assert.deepEqual(ingles.commitments[0].cadence, { kind: "daily", weekdays: null, n: null });
  assert.equal(ingles.commitments[0].target, 30);
  assert.equal(ingles.commitments[0].unit, "h");
  assert.equal(named(got, "Leer").measureFed, false);
  assert.equal(named(got, "Correr").measureFed, false);
});

test("tasks carry their children and what is done", async () => {
  const leer = named(await load(), "Leer");
  assert.equal(leer.tasks.length, 1);
  const [task] = leer.tasks;
  assert.deepEqual(
    { name: task.name, estimate: task.estimate, month: task.month, done: task.done },
    { name: "Capítulo", estimate: 60, month: month(1), done: false },
  );
  assert.deepEqual(
    task.children.map(({ name, done }) => ({ name, done })).sort((a, b) => (a.name < b.name ? -1 : 1)),
    [
      { name: "Fichas", done: false },
      { name: "Resumen", done: true },
    ],
  );
});

test("called with a transaction it sees what that transaction wrote", async () => {
  class Rollback extends Error {}
  let seen: GoalSnapshot[] = [];
  await assert.rejects(
    session.actAs(asResolved(mine), () =>
      session.withGoalsDb(async (tx) => {
        await tx.execute(sql`insert into goals.goals (user_id, name, position) values (${mine.id}, 'Escribir', 99)`);
        seen = await match.loadImportSnapshots(["Escribir"], tx);
        throw new Rollback();
      }),
    ),
    Rollback,
  );
  assert.deepEqual(seen.map((g) => g.name), ["Escribir"]);
  assert.equal((await load(["Escribir"])).length, 0);
});
