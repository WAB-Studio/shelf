// Proves what `loadGoal` and `listGoalsForMetas` hand a goal with goals under it
// (RP-80, RP-81, RP-83, RP-79, RP-95, RNP-03, RNP-12): the sums by month in the
// holder's unit, the span that opens with its earliest goal, the stored rhythm
// left unread, and the tree around a goal. Rows are planted by the admin door
// with explicit positions and dates, so the expected figures are written down
// from the plant and never read back through the code under test. Evidence is
// a stub that answers the bounds it is handed, as `horizon-evidence.ts` does.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Module from "node:module";
import { after, before, test } from "node:test";

import { sql as dsql, type SQL } from "drizzle-orm";
import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "../mcp/lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

const admin = adminSql();
const wire: string[] = [];
const door = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 1,
  debug: (_connection: number, query: string) => void wire.push(query),
});
(globalThis as unknown as { sql: unknown }).sql = door;

type ReaderTx = { execute: (query: SQL) => Promise<Array<{ f: string; t: string }>> };
type Planted = { personId: string; day: string; quantity: number };
const planted: Planted[] = [];

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (request === "next/cache") return { revalidatePath() {} };
    if (request === "./reading-lookups") {
      return {
        readReadingLookups: async (args: { personId: string; from: string | SQL; to: string | SQL; tx: ReaderTx }) => {
          const [bounds] = await args.tx.execute(dsql`select (${args.from})::date as f, (${args.to})::date as t`);
          return planted
            .filter((row) => row.personId === args.personId && row.day >= String(bounds.f) && row.day <= String(bounds.t))
            .map((row) => ({
              day: row.day,
              quantity: row.quantity,
              unit: "searches",
              labelKey: "sources.readingLookups",
            }));
        },
      };
    }
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
let goalQueries: typeof import("@/lib/queries/goal");
let today: string;
let month: string;
let farHorizon: string;
let midHorizon: string;
let owner: Person;
let other: Person;
let single: Person;

const as = <T>(person: Person, read: () => Promise<T>): Promise<T> => session.actAs(asResolved(person), read);

type GoalSeed = {
  user: Person;
  name: string;
  parent?: string | null;
  position: number;
  unit?: string | null;
  horizon?: string;
  createdDay?: string;
  rhythm?: number | null;
  note?: string | null;
  archived?: boolean;
  id?: string;
};

async function plantGoal(seed: GoalSeed): Promise<string> {
  const id = seed.id ?? randomUUID();
  const created = `${seed.createdDay ?? addDays(today, -10)}T15:00:00Z`;
  await admin`
    insert into goals.goals (id, user_id, name, horizon, measure_name, measure_unit, created_at, archived_at,
                             position, rhythm, parent_id, note)
    values (${id}, ${seed.user.id}, ${seed.name}, ${seed.horizon ?? midHorizon},
            ${seed.unit ? "Medida" : null}, ${seed.unit ?? null}, ${created},
            ${seed.archived ? created : null}, ${seed.position}, ${seed.rhythm ?? null},
            ${seed.parent ?? null}, ${seed.note ?? null})`;
  return id;
}

// An amount planned for the current month and a quantity done today, in the goal's unit.
async function plantMonth(
  user: Person,
  goalId: string,
  figures: { planned?: number; reached?: number },
): Promise<void> {
  if (figures.planned !== undefined) {
    await admin`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${user.id}, ${goalId}, ${month}, ${figures.planned})`;
  }
  if (figures.reached !== undefined) {
    const [{ id }] = await admin<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit)
      select ${user.id}, g.id, 'plant', 'daily', 'quantity', 10, g.measure_unit
        from goals.goals g where g.id = ${goalId}
      returning id`;
    await admin`
      insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
      values (${user.id}, ${id}, ${goalId}, ${today}, ${figures.reached})`;
  }
}

// The trees, by name.
const ids: Record<string, string> = {};

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  goalQueries = await import("@/lib/queries/goal");
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  month = `${today.slice(0, 7)}-01`;
  farHorizon = addDays(today, 200);
  midHorizon = addDays(today, 120);

  const runId = await openCheckRun(admin);
  [owner, other, single] = await createPeople(admin, runId, door, 3);

  // T1: a general in minutes over two large goals in minutes and one in km.
  ids.G = await plantGoal({ user: owner, name: "T1 general", position: 100, unit: "min", horizon: farHorizon });
  ids.A = await plantGoal({ user: owner, name: "T1 A", parent: ids.G, position: 2, unit: "min" });
  ids.B = await plantGoal({ user: owner, name: "T1 B", parent: ids.G, position: 1, unit: "min" });
  ids.C = await plantGoal({ user: owner, name: "T1 C km", parent: ids.G, position: 3, unit: "km" });
  await plantMonth(owner, ids.A, { planned: 120, reached: 60 });
  await plantMonth(owner, ids.B, { planned: 60, reached: 30 });
  await plantMonth(owner, ids.C, { planned: 5, reached: 3 });

  // T2: general H over a large X holding a small p; X stores a budget before p arrives.
  ids.H = await plantGoal({ user: owner, name: "T2 general", position: 110, unit: "min", horizon: farHorizon });
  ids.Z = await plantGoal({ user: owner, name: "T2 Z", parent: ids.H, position: 5, unit: "min" });
  ids.X = await plantGoal({ user: owner, name: "T2 X", position: 7, unit: "min" });
  await plantMonth(owner, ids.X, { planned: 100, reached: 10 });
  await admin`update goals.goals set parent_id = ${ids.H} where id = ${ids.X}`;
  ids.p = await plantGoal({ user: owner, name: "T2 p", parent: ids.X, position: 1, unit: "min" });
  await plantMonth(owner, ids.p, { reached: 20 });
  await plantMonth(owner, ids.H, { reached: 5 });

  // T3: a goal that stores a rhythm and a month amount before it holds a goal.
  ids.R = await plantGoal({ user: owner, name: "T3 holder", position: 120, unit: "min", rhythm: 600, horizon: farHorizon });
  await plantMonth(owner, ids.R, { planned: 999 });
  await admin`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, in_plan, estimate)
    values (${owner.id}, ${ids.R}, 'T3 fixed task', ${month}, true, 15)`;
  ids.q = await plantGoal({ user: owner, name: "T3 q", parent: ids.R, position: 1, unit: "min" });
  await plantMonth(owner, ids.q, { planned: 50, reached: 10 });

  // T4: two open goals and one archived below; the one that ends last is second.
  ids.K = await plantGoal({
    user: owner,
    name: "T4 general",
    position: 130,
    horizon: farHorizon,
    note: "first line\nsecond line\n\n  indented third",
  });
  ids.k1 = await plantGoal({ user: owner, name: "T4 k1", parent: ids.K, position: 1, horizon: addDays(today, 60) });
  ids.k2 = await plantGoal({ user: owner, name: "T4 k2", parent: ids.K, position: 2, horizon: addDays(today, 150) });
  ids.k3 = await plantGoal({
    user: owner,
    name: "T4 k3",
    parent: ids.K,
    position: 3,
    horizon: addDays(today, 190),
    archived: true,
  });

  // T5: the child opened before the general, with the general's evidence on that day.
  ids.E = await plantGoal({
    user: owner,
    name: "T5 general",
    position: 140,
    unit: "searches",
    horizon: farHorizon,
    createdDay: addDays(today, -2),
  });
  ids.F = await plantGoal({
    user: owner,
    name: "T5 child",
    parent: ids.E,
    position: 1,
    unit: "searches",
    createdDay: addDays(today, -5),
  });
  const [{ id: sourceId }] = await admin<{ id: string }[]>`select id from goals.evidence_sources where key = 'reading_lookups'`;
  await admin`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, source_id, threshold)
    values (${owner.id}, ${ids.E}, 'T5 evidence', 'daily', 'evidence', ${sourceId}, 1)`;
  planted.push({ personId: owner.id, day: addDays(today, -5), quantity: 7 });

  // Somebody else's goal, in a tree of its own.
  ids.O = await plantGoal({ user: other, name: "other general", position: 1, unit: "min", horizon: farHorizon });
  ids.o1 = await plantGoal({ user: other, name: "other child", parent: ids.O, position: 1, unit: "min" });
});

after(async () => {
  try {
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

const view = async (id: string, person: Person = owner) => {
  const loaded = await as(person, () => goalQueries.loadGoal(id, today));
  assert.ok(loaded, `goal ${id} loads`);
  return loaded;
};

const thisMonthOf = (goal: Awaited<ReturnType<typeof view>>) => goal.months.find((m) => m.month === month);

test("a general's month is its goals' amounts and reached, summed in the unit", async () => {
  const g = await view(ids.G);
  assert.equal(g.holdsGoals, true);
  assert.deepEqual(
    { planned: thisMonthOf(g)?.planned, reached: thisMonthOf(g)?.reached },
    { planned: 180, reached: 90 },
  );
  assert.deepEqual(g.month && { planned: g.month.planned, reached: g.month.reached }, { planned: 180, reached: 90 });
  assert.equal(g.measureTotal, 90);
});

test("a goal in another unit adds nothing and is named", async () => {
  const g = await view(ids.G);
  assert.deepEqual(g.outOfUnit, [{ id: ids.C, name: "T1 C km", unit: "km" }]);
  const c = g.children.find((child) => child.id === ids.C);
  assert.equal(c?.inUnit, false);
  assert.equal(c?.unit, "km");
  assert.deepEqual(c?.month, { planned: 5, reached: 3 });
  assert.equal(g.children.find((child) => child.id === ids.A)?.inUnit, true);
});

test("a small goal's reached climbs to the general, with the large goal's and the general's own", async () => {
  const h = await view(ids.H);
  assert.equal(thisMonthOf(h)?.reached, 35);
  assert.equal(thisMonthOf(h)?.planned, null);
  const x = h.children.find((child) => child.id === ids.X);
  assert.deepEqual(x?.month, { planned: null, reached: 30 });
});

test("the goal above and the ones above that, the top one first; the goals under, in order", async () => {
  const p = await view(ids.p);
  assert.equal(p.parent?.id, ids.X);
  assert.deepEqual(p.ancestors.map((a) => a.id), [ids.H, ids.X]);
  assert.equal(p.level, "small");
  const h = await view(ids.H);
  assert.deepEqual(h.children.map((child) => child.id), [ids.Z, ids.X]);
  assert.deepEqual(h.children.map((child) => child.level), ["large", "large"]);
  assert.equal(h.level, "general");
  assert.equal(h.parent, null);
  assert.deepEqual(h.ancestors, []);
});

test("a stored rhythm and month amount are returned empty and unread", async () => {
  const r = await view(ids.R);
  assert.equal(r.rhythm, null);
  assert.deepEqual(r.budgets, []);
  assert.equal(r.plan.rhythm, null);
  assert.deepEqual(r.plan.budgets, []);
  assert.equal(r.roadmap.months.length, 0);
  assert.equal(thisMonthOf(r)?.planned, 50);
  assert.equal(thisMonthOf(r)?.reached, 10);
  const stored = await admin`select rhythm from goals.goals where id = ${ids.R}`;
  assert.equal(stored[0].rhythm, 600);
  // Its tasks keep the month they were written for.
  assert.deepEqual(r.tasks.map((t) => [t.name, t.plannedMonth]), [["T3 fixed task", month]]);
});

test("the general opens with its earliest goal, so evidence from before itself counts", async () => {
  const e = await view(ids.E);
  assert.equal(e.measureTotal, 7);
  assert.equal(e.months.find((m) => m.month === `${addDays(today, -5).slice(0, 7)}-01`)?.reached, 7);
});

test("how many open goals sit under a goal, archived ones left out", async () => {
  const k = await view(ids.K);
  assert.equal(k.branchOpenCount, 2);
  assert.deepEqual(k.children.map((c) => c.archivedAt !== null), [false, false, true]);
});

test("the goal under it that ends last, not the first", async () => {
  const k = await view(ids.K);
  assert.equal(k.latestBelow?.id, ids.k3);
  const x = await view(ids.X);
  assert.equal(x.latestBelow?.id, ids.p);
  assert.equal(x.above?.id, ids.H);
});

test("the note comes whole, line breaks included", async () => {
  const k = await view(ids.K);
  assert.equal(k.note, "first line\nsecond line\n\n  indented third");
});

test("a goal alone has no tree figures and the same old fields", async () => {
  const [A1, A2] = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002"];
  const commitment = "aaaaaaaa-0000-4000-8000-000000000003";
  const task = "aaaaaaaa-0000-4000-8000-000000000004";
  const doneTask = "aaaaaaaa-0000-4000-8000-000000000005";
  await admin`
    insert into goals.goals (id, user_id, name, horizon, measure_name, measure_unit, created_at, position, rhythm)
    values (${A1}, ${single.id}, 'alone', '2027-02-01', 'Tiempo', 'min', '2026-09-20T15:00:00Z', 1, 600)`;
  await admin`
    insert into goals.goals (id, user_id, name, horizon, created_at, position, archived_at, note)
    values (${A2}, ${single.id}, 'alone archived', '2026-12-01', '2026-09-20T15:00:00Z', 2, '2026-09-25T15:00:00Z', 'a note')`;
  await admin`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${single.id}, ${A1}, '2026-10-01', 750)`;
  await admin`
    insert into goals.commitments (id, user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${commitment}, ${single.id}, ${A1}, 'plant', 'daily', 'quantity', 30, 'min', '2026-09-21T15:00:00Z')`;
  await admin`
    insert into goals.facts (user_id, commitment_id, goal_id, day, quantity, written_at)
    values (${single.id}, ${commitment}, ${A1}, '2026-10-05', 45, '2026-10-05T15:00:00Z')`;
  await admin`
    insert into goals.one_offs (id, user_id, goal_id, name, planned_month, in_plan, estimate, created_at)
    values (${task}, ${single.id}, ${A1}, 'later', '2026-11-01', true, 60, '2026-09-21T15:00:00Z')`;
  await admin`
    insert into goals.one_offs (id, user_id, goal_id, name, in_plan, estimate, created_at)
    values (${doneTask}, ${single.id}, ${A1}, 'done', true, 20, '2026-09-21T15:00:00Z')`;
  await admin`
    insert into goals.facts (id, user_id, one_off_id, goal_id, day, written_at)
    values ('aaaaaaaa-0000-4000-8000-000000000006', ${single.id}, ${doneTask}, ${A1}, '2026-10-06', '2026-10-06T15:00:00Z')`;

  const loaded = await as(single, () => goalQueries.loadGoal(A1, "2026-10-12"));
  assert.ok(loaded);
  if (process.env.DUMP) {
    const metasNow = await as(single, () => goalQueries.listGoalsForMetas("2026-10-12"));
    console.log("DUMPVIEW" + JSON.stringify(loaded));
    console.log("DUMPMETAS" + JSON.stringify(metasNow));
  }
  assert.deepEqual(
    {
      parent: loaded.parent,
      ancestors: loaded.ancestors,
      level: loaded.level,
      holdsGoals: loaded.holdsGoals,
      children: loaded.children,
      outOfUnit: loaded.outOfUnit,
      branchOpenCount: loaded.branchOpenCount,
      latestBelow: loaded.latestBelow,
      above: loaded.above,
      note: loaded.note,
      treeIds: loaded.tree.map((n) => n.id),
    },
    {
      parent: null,
      ancestors: [],
      level: null,
      holdsGoals: false,
      children: [],
      outOfUnit: [],
      branchOpenCount: 0,
      latestBelow: null,
      above: null,
      note: null,
      treeIds: [A1, A2],
    },
  );
  const old: Record<string, unknown> = { ...loaded };
  for (const key of [
    "note", "parent", "ancestors", "level", "holdsGoals", "children", "outOfUnit",
    "branchOpenCount", "latestBelow", "above", "tree", "deletable", "measureFed", "marked",
  ]) {
    delete old[key];
  }
  // Not tree figures: what the goal holds decides these (RP-127, RP-134).
  assert.equal(loaded.deletable, false);
  assert.equal(loaded.measureFed, true);
  // The days a commitment was marked, read for «Abrir en Claude»: new since the golden view.
  assert.deepEqual(loaded.marked, [{ day: "2026-10-05", name: "plant" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(old)), GOLDEN_VIEW);

  const metas = await as(single, () => goalQueries.listGoalsForMetas("2026-10-12"));
  const bare = (row: Record<string, unknown>) => {
    const { parentId, level, outOfUnit, monthUnit, ...rest } = row;
    assert.equal(parentId, null);
    assert.equal(level, null);
    if (outOfUnit !== undefined) assert.deepEqual(outOfUnit, []);
    // A goal alone draws its month in its own measure's unit.
    if (monthUnit !== undefined) assert.equal(monthUnit, rest.measureUnit ?? null);
    return rest;
  };
  assert.deepEqual(JSON.parse(JSON.stringify({
    open: metas.open.map(bare),
    ended: metas.ended.map(bare),
    archived: metas.archived.map(bare),
  })), GOLDEN_METAS);
});

test("/metas lists a tree in tree order, each with its place", async () => {
  const metas = await as(owner, () => goalQueries.listGoalsForMetas(today));
  const t2 = [ids.H, ids.Z, ids.X, ids.p];
  const rows = metas.open.filter((row) => t2.includes(row.id));
  assert.deepEqual(rows.map((row) => row.id), t2);
  assert.deepEqual(rows.map((row) => row.parentId), [null, ids.H, ids.H, ids.X]);
  assert.deepEqual(rows.map((row) => row.level), ["general", "large", "large", "small"]);
  const k = metas.archived.find((row) => row.id === ids.k3);
  assert.equal(k?.parentId, ids.K);
  assert.equal(k?.level, "large");
});

test("/metas shows a general's month summed in its unit and names the goals left out", async () => {
  const metas = await as(owner, () => goalQueries.listGoalsForMetas(today));
  const g = metas.open.find((row) => row.id === ids.G);
  assert.deepEqual(g?.month, { kind: "amount", month, planned: 180, reached: 90 });
  assert.deepEqual(g?.outOfUnit, [{ id: ids.C, name: "T1 C km", unit: "km" }]);
  const h = metas.open.find((row) => row.id === ids.H);
  assert.deepEqual(h?.month, { kind: "amount", month, planned: null, reached: 35 });
  const r = metas.open.find((row) => row.id === ids.R);
  assert.deepEqual(r?.month, { kind: "amount", month, planned: 50, reached: 10 });
});

test("the tree holds the person's goals alone", async () => {
  const g = await view(ids.G);
  const mine = new Set(g.tree.map((n) => n.id));
  assert.ok(mine.has(ids.G) && mine.has(ids.p));
  assert.ok(!mine.has(ids.O) && !mine.has(ids.o1));
  const theirs = await view(ids.O, other);
  assert.deepEqual(theirs.tree.map((n) => n.id).sort(), [ids.O, ids.o1].sort());
  assert.equal(await as(owner, () => goalQueries.loadGoal(ids.O, today)), null);
  const place = await as(other, () => goalQueries.loadGoalPlace(ids.O));
  assert.deepEqual(place?.tree.map((n) => n.id).sort(), [ids.O, ids.o1].sort());
  assert.equal(await as(owner, () => goalQueries.loadGoalPlace(ids.O)), null);
});

test("loadGoalPlace names the goal, its level, its opening day and its tree", async () => {
  const place = await as(owner, () => goalQueries.loadGoalPlace(ids.X));
  assert.ok(place);
  assert.equal(place.goal.id, ids.X);
  assert.equal(place.level, "large");
  assert.equal(place.archivedAt, null);
  assert.equal(place.openedOn, addDays(today, -10));
  assert.ok(place.tree.some((n) => n.id === ids.p));
});

test("loadGoalPlace costs 2 statements: the settle and one read", async () => {
  wire.length = 0;
  const place = await as(owner, () => goalQueries.loadGoalPlace(ids.X));
  assert.ok(place);
  const statements = wire.filter((query) => !/^\s*(begin|commit)\s*$/i.test(query));
  assert.equal(statements.length, 2, statements.map((s) => s.slice(0, 90).replace(/\s+/g, " ")).join(" | "));
});

// Written down from the loaders as they stood before the tree, over the plant
// above with `today = 2026-10-12`.
const GOLDEN_VIEW: unknown = {
  "deleteBlock": "facts",
  "id": "aaaaaaaa-0000-4000-8000-000000000001",
  "name": "alone",
  "horizon": "2027-02-01",
  "endedOn": null,
  "createdAt": "2026-09-20T15:00:00+00:00",
  "measureName": "Tiempo",
  "measureUnit": "min",
  "archivedAt": null,
  "measureTotal": 45,
  "phases": [],
  "commitments": [
    {
      "id": "aaaaaaaa-0000-4000-8000-000000000003",
      "name": "plant",
      "cadence": {
        "kind": "daily"
      },
      "satisfiedBy": {
        "kind": "quantity",
        "target": 30,
        "unit": "min"
      },
      "retiredAt": null,
      "sourceLabelKey": null,
      "factDayCount": 1
    }
  ],
  "weeks": [
    {
      "index": 1,
      "startsOn": "2026-09-20",
      "endsOn": "2026-09-20",
      "total": 0,
      "phaseName": null,
      "current": false
    },
    {
      "index": 2,
      "startsOn": "2026-09-21",
      "endsOn": "2026-09-27",
      "total": 0,
      "phaseName": null,
      "current": false
    },
    {
      "index": 3,
      "startsOn": "2026-09-28",
      "endsOn": "2026-10-04",
      "total": 0,
      "phaseName": null,
      "current": false
    },
    {
      "index": 4,
      "startsOn": "2026-10-05",
      "endsOn": "2026-10-11",
      "total": 45,
      "phaseName": null,
      "current": false
    },
    {
      "index": 5,
      "startsOn": "2026-10-12",
      "endsOn": "2026-10-18",
      "total": 0,
      "phaseName": null,
      "current": true
    }
  ],
  "evidence": "read",
  "month": {
    "month": "2026-10-01",
    "planned": 750,
    "reached": 45,
    "underPace": false
  },
  "months": [
    {
      "month": "2026-09-01",
      "planned": 220,
      "reached": 0,
      "current": false,
      "past": true
    },
    {
      "month": "2026-10-01",
      "planned": 750,
      "reached": 45,
      "current": true,
      "past": false
    },
    {
      "month": "2026-11-01",
      "planned": 600,
      "reached": 0,
      "current": false,
      "past": false
    },
    {
      "month": "2026-12-01",
      "planned": 600,
      "reached": 0,
      "current": false,
      "past": false
    },
    {
      "month": "2027-01-01",
      "planned": 600,
      "reached": 0,
      "current": false,
      "past": false
    }
  ],
  "budgets": [
    {
      "month": "2026-10-01",
      "amount": 750
    }
  ],
  "tasks": [
    {
      "id": "aaaaaaaa-0000-4000-8000-000000000004",
      "parentId": null,
      "name": "later",
      "plannedMonth": "2026-11-01",
      "day": null,
      "estimate": 60,
      "doneOn": null,
      "factId": null,
      "note": null,
      "inPlan": true,
      "position": 1,
      "createdOn": "2026-09-21"
    },
    {
      "id": "aaaaaaaa-0000-4000-8000-000000000005",
      "parentId": null,
      "name": "done",
      "plannedMonth": null,
      "day": null,
      "estimate": 20,
      "doneOn": "2026-10-06",
      "factId": "aaaaaaaa-0000-4000-8000-000000000006",
      "note": null,
      "inPlan": true,
      "position": 2,
      "createdOn": "2026-09-21"
    }
  ],
  "rhythm": 600,
  "planSeen": null,
  "plan": {
    "rhythm": 600,
    "budgets": [
      {
        "month": "2026-10-01",
        "amount": 750
      }
    ],
    "tasks": [
      {
        "id": "aaaaaaaa-0000-4000-8000-000000000004",
        "parentId": null,
        "name": "later",
        "plannedMonth": "2026-11-01",
        "day": null,
        "estimate": 60,
        "doneOn": null,
        "factId": null,
        "note": null,
        "inPlan": true,
        "position": 1,
        "createdOn": "2026-09-21"
      },
      {
        "id": "aaaaaaaa-0000-4000-8000-000000000005",
        "parentId": null,
        "name": "done",
        "plannedMonth": null,
        "day": null,
        "estimate": 20,
        "doneOn": "2026-10-06",
        "factId": "aaaaaaaa-0000-4000-8000-000000000006",
        "note": null,
        "inPlan": true,
        "position": 2,
        "createdOn": "2026-09-21"
      }
    ],
    "openedOn": "2026-09-20",
    "horizon": "2027-02-01",
    "today": "2026-10-12"
  },
  "roadmap": {
    "state": "planned",
    "months": [
      {
        "month": "2026-10-01",
        "amount": 750,
        "filled": 20,
        "items": [
          {
            "task": {
              "id": "aaaaaaaa-0000-4000-8000-000000000005",
              "parentId": null,
              "name": "done",
              "plannedMonth": null,
              "day": null,
              "estimate": 20,
              "doneOn": "2026-10-06",
              "factId": "aaaaaaaa-0000-4000-8000-000000000006",
              "note": null,
              "inPlan": true,
              "position": 2,
              "createdOn": "2026-09-21"
            },
            "children": [],
            "hours": 20,
            "part": 20,
            "from": null,
            "to": null,
            "fixed": false,
            "carriedFrom": null,
            "done": true,
            "endsOn": null,
            "pastEnd": false
          }
        ]
      },
      {
        "month": "2026-11-01",
        "amount": 600,
        "filled": 60,
        "items": [
          {
            "task": {
              "id": "aaaaaaaa-0000-4000-8000-000000000004",
              "parentId": null,
              "name": "later",
              "plannedMonth": "2026-11-01",
              "day": null,
              "estimate": 60,
              "doneOn": null,
              "factId": null,
              "note": null,
              "inPlan": true,
              "position": 1,
              "createdOn": "2026-09-21"
            },
            "children": [],
            "hours": 60,
            "part": 60,
            "from": null,
            "to": null,
            "fixed": true,
            "carriedFrom": null,
            "done": false,
            "endsOn": "2026-11-03",
            "pastEnd": false
          }
        ]
      }
    ],
    "unplaced": [],
    "end": "2026-11-03",
    "lastDay": "2027-01-31"
  }
};
const GOLDEN_METAS: unknown = {
  "open": [
    {
      "id": "aaaaaaaa-0000-4000-8000-000000000001",
      "name": "alone",
      "horizon": "2027-02-01",
      "measureName": "Tiempo",
      "measureUnit": "min",
      "archivedAt": null,
      "month": {
        "kind": "amount",
        "month": "2026-10-01",
        "planned": 750,
        "reached": 45
      }
    }
  ],
  "ended": [],
  "archived": [
    {
      "id": "aaaaaaaa-0000-4000-8000-000000000002",
      "name": "alone archived",
      "horizon": "2026-12-01",
      "measureName": null,
      "measureUnit": null,
      "archivedAt": "2026-09-25 15:00:00+00"
    }
  ]
};

test("listGoals hands each open goal its parent, in the tree's order: siblings by position, a goal's goals right after it, archived left out", async () => {
  const listed = await as(owner, () => goalQueries.listGoals());
  const own = new Set(Object.values(ids));
  const mine = listed.filter((goal) => own.has(goal.id)) as Array<(typeof listed)[number] & { parentId?: string | null }>;
  assert.deepEqual(
    mine.map((goal) => goal.id),
    [ids.G, ids.B, ids.A, ids.C, ids.H, ids.Z, ids.X, ids.p, ids.R, ids.q, ids.K, ids.k1, ids.k2, ids.E, ids.F],
  );
  assert.deepEqual(
    mine.map((goal) => [goal.id, goal.parentId ?? null]),
    [
      [ids.G, null], [ids.B, ids.G], [ids.A, ids.G], [ids.C, ids.G],
      [ids.H, null], [ids.Z, ids.H], [ids.X, ids.H], [ids.p, ids.X],
      [ids.R, null], [ids.q, ids.R],
      [ids.K, null], [ids.k1, ids.K], [ids.k2, ids.K],
      [ids.E, null], [ids.F, ids.E],
    ],
  );
  assert.ok(!listed.some((goal) => goal.id === ids.O || goal.id === ids.o1), "another person's goals never come");
});
