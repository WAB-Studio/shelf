// What `loadReport` hands paper about each goal (RP-124, RP-84): its live
// commitments in plan order, and how many tasks each month's list holds,
// whether the goal counts tasks or not. Rows are planted by the admin door, so
// every expected figure is written down from the plant.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
    if (request === "./reading-lookups") return { readReadingLookups: async () => [] };
    return originalLoad(request, parent, isMain);
  };
}

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

let session: typeof import("@/lib/session");
let reportQueries: typeof import("@/lib/queries/report");
let today: string;
let month: string;
let owner: Person;

const as = <T>(read: () => Promise<T>): Promise<T> => session.actAs(asResolved(owner), read);

async function plant(name: string, position: number, unit: string | null): Promise<string> {
  const id = randomUUID();
  await admin`
    insert into goals.goals (id, user_id, name, horizon, measure_name, measure_unit, created_at, position)
    values (${id}, ${owner.id}, ${name}, ${addDays(today, 200)}, ${unit === null ? null : "Medida"}, ${unit},
            ${`${addDays(today, -10)}T15:00:00Z`}, ${position})`;
  return id;
}

const ids: Record<string, string> = {};

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  reportQueries = await import("@/lib/queries/report");
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  month = `${today.slice(0, 7)}-01`;
  const runId = await openCheckRun(admin);
  [owner] = await createPeople(admin, runId, door, 1);

  // K3: two live commitments planted against their creation order, and a retired one between them.
  ids.K3 = await plant("K3 hábitos", 1, null);
  const habit = (name: string, position: number, retired: boolean) => admin`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, position, retired_at)
    values (${owner.id}, ${ids.K3}, ${name}, 'daily', 'binary', ${position}, ${retired ? new Date().toISOString() : null})`;
  await habit("K3 Tomar agua", 20, false);
  await habit("K3 Retirado", 15, true);
  await habit("K3 Estirar", 10, false);

  // K3b: a commitment of quantity.
  ids.K3b = await plant("K3b rodaje", 2, "km");
  await admin`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, satisfaction, target_quantity, unit)
    values (${owner.id}, ${ids.K3b}, 'K3b Rodaje', 'times_per_week', 3, 'quantity', 5, 'km')`;

  // K4: a goal in pages with one task fixed to this month.
  ids.K4 = await plant("K4 páginas", 3, "páginas");
  await admin`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, in_plan)
    values (${owner.id}, ${ids.K4}, 'K4 tarea', ${month}, true)`;

  // K5: a goal in words with no task, which carries no `tasks` today.
  ids.K5 = await plant("K5 palabras", 4, "palabras");
});

after(async () => {
  try {
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

const goalOf = async (id: string) => {
  const report = await as(() => reportQueries.loadReport(today));
  const goal = report.goals.find((entry) => entry.id === id);
  assert.ok(goal, `report holds ${id}`);
  return goal;
};

test("commitments: the live ones in plan order, the retired one out (K3)", async () => {
  const goal = await goalOf(ids.K3);
  assert.deepEqual(
    goal.commitments?.map((c) => [c.name, c.cadence]),
    [
      ["K3 Estirar", { kind: "daily" }],
      ["K3 Tomar agua", { kind: "daily" }],
    ],
  );
});

test("commitments: a quantity keeps its amount and its unit; a goal with none says []", async () => {
  const [rodaje] = (await goalOf(ids.K3b)).commitments ?? [];
  assert.deepEqual(
    [rodaje.name, rodaje.cadence, rodaje.targetQuantity, rodaje.unit],
    ["K3b Rodaje", { kind: "times_per_week", count: 3 }, 5, "km"],
  );
  assert.deepEqual((await goalOf(ids.K4)).commitments, []);
});

test("months: every month carries how many tasks its list holds, counting goals or not", async () => {
  for (const [id, thisMonth] of [[ids.K4, 1], [ids.K5, 0]] as const) {
    const goal = await goalOf(id);
    const counts = new Map(goal.months.map((m) => [m.month, m.taskCount]));
    assert.equal(counts.get(month), thisMonth, id);
    assert.equal(counts.get(`${addDays(month, 32).slice(0, 7)}-01`), 0, id);
    assert.ok(goal.months.every((m) => m.tasks === undefined), "tasks stays out of a goal that measures");
  }
});
