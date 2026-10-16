// Drives the four plan readers (RP-45): each hands back the note
// of a task, a sub-task and a carried item. Notes are planted by direct SQL;
// the session `harness:mint-session` left standing, `server-only`,
// `next/headers` and `next/cache` stubbed before the first `@/` import.
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

const lane = laneNumber();

type StoredCookie = { name: string; value: string };

function loadCookies(): StoredCookie[] {
  const file = resolve(process.cwd(), `private/session-${lane}.json`);
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
    if (request === "next/cache") return { revalidatePath() {} };
    if (request === "./reading-lookups") return { readReadingLookups: async () => [] };
    return originalLoad(request, parent, isMain);
  };
}

function monthFrom(day: string, delta: number): string {
  const index = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });

const NOTES = {
  parent: "RP-45 nota: la madre",
  child: "RP-45 nota: la hija",
  carried: "RP-45 nota: la arrastrada",
  carriedChild: "RP-45 nota: la hija arrastrada",
};

let goalId: string;
let today: string;
const ids: Record<string, string> = {};
let loadGoal: typeof import("@/lib/queries/goal").loadGoal;
let listGoalsForMetas: typeof import("@/lib/queries/goal").listGoalsForMetas;
let loadMonthAcross: typeof import("@/lib/queries/month").loadMonthAcross;
let loadReport: typeof import("@/lib/queries/report").loadReport;

before(async () => {
  installStubs(loadCookies());
  const plan = await import("@/app/actions/plan");
  ({ loadGoal, listGoalsForMetas } = await import("@/lib/queries/goal"));
  ({ loadMonthAcross } = await import("@/lib/queries/month"));
  ({ loadReport } = await import("@/lib/queries/report"));
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  const created = await plan.createGoal({
    name: "RP-45 fixture: notas",
    horizon: `${monthFrom(today, 2)}-01`,
  });
  if (!created.ok) throw new Error(`createGoal: ${created.error}`);
  goalId = created.goalId;
  const [owner] = await sql<{ user_id: string }[]>`
    select user_id from goals.goals where id = ${goalId}`;
  async function task(name: string, month: string | null, parent: string | null, note: string | null) {
    const [row] = await sql<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, parent_id, estimate, note)
      values (${owner.user_id}, ${goalId}, ${name}, ${month}, ${parent}, ${parent ? 40 : null}, ${note})
      returning id`;
    return row.id;
  }
  const thisMonth = `${today.slice(0, 7)}-01`;
  ids.parent = await task("RP-45 madre", thisMonth, null, NOTES.parent);
  ids.child = await task("RP-45 hija", null, ids.parent, NOTES.child);
  ids.plain = await task("RP-45 sin nota", thisMonth, null, null);
  ids.carried = await task("RP-45 arrastrada", `${monthFrom(today, -1)}-01`, null, NOTES.carried);
  ids.carriedChild = await task("RP-45 hija arrastrada", null, ids.carried, NOTES.carriedChild);
});

after(async () => {
  if (goalId) await sql`delete from goals.goals where id = ${goalId}`;
  await sql.end();
});

test("loadGoal: a task and a sub-task read their note, a task without one reads null", async () => {
  const goal = await loadGoal(goalId, today);
  assert.ok(goal);
  const note = (id: string) => goal.tasks.find((task) => task.id === id)?.note;
  assert.equal(note(ids.parent), NOTES.parent);
  assert.equal(note(ids.child), NOTES.child);
  assert.equal(note(ids.plain), null);
});

test("loadMonthAcross: a task and its sub-task carry their note", async () => {
  const month = await loadMonthAcross(today);
  const items = month.goals.find((goal) => goal.id === goalId)?.items ?? [];
  const parent = items.find((item) => item.task.id === ids.parent);
  assert.ok(parent);
  assert.equal(parent.task.note, NOTES.parent);
  assert.equal(parent.children.find((child) => child.id === ids.child)?.note, NOTES.child);
  assert.equal(items.find((item) => item.task.id === ids.plain)?.task.note, null);
});

test("loadReport: a carried task and its undone child carry their note", async () => {
  const report = await loadReport(today);
  const carried = report.goals.find((goal) => goal.id === goalId)?.carried ?? [];
  const item = carried.find((entry) => entry.name === "RP-45 arrastrada");
  assert.ok(item);
  assert.equal(item.note, NOTES.carried);
  assert.equal(item.children.find((child) => child.name === "RP-45 hija arrastrada")?.note, NOTES.carriedChild);
});

// `listGoalsForMetas` folds tasks into counts, so the note it maps is not
// readable from its answer: the probe holds that a noted task still counts.
test("listGoalsForMetas: a goal with noted tasks still reads its month as tasks, counts unchanged", async () => {
  const { open } = await listGoalsForMetas(today);
  const entry = open.find((goal) => goal.id === goalId);
  assert.ok(entry);
  assert.deepEqual(entry.month && entry.month.kind === "tasks" ? [entry.month.done, entry.month.total] : null, [0, 3]);
});
