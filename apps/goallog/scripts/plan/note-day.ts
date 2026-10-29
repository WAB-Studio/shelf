// Drives the day's and the loose lists' readers (RP-45):
// actions imported as plain async functions, `server-only`, `next/headers` and `next/cache` stubbed before the
// first `@/` import, and the cookie `harness:mint-session` left standing is
// the session `getPerson()` reads. Notes are written by direct SQL.
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
let createGoal: typeof import("@/app/actions/plan").createGoal;


async function created(input: Parameters<Actions["createOneOff"]>[0]): Promise<string> {
  const result = await actions.createOneOff(input);
  if (!result.ok) throw new Error(`createOneOff ${input.name}: ${result.error}`);
  return result.oneOffId;
}

async function noted(id: string, note: string): Promise<void> {
  await sql`update goals.one_offs set note = ${note} where id = ${id}`;
}

function dayAfter(day: string, delta: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, {
  prepare: false,
  max: 1,
  connection: { statement_timeout: 15_000, lock_timeout: 10_000 },
});

const goalIds: string[] = [];
const looseIds: string[] = [];
let today: string;
let goalId: string;

before(async () => {
  installStubs(loadCookies());
  const plan = await import("@/app/actions/plan");
  actions = await import("@/app/actions/one-offs");
  createGoal = plan.createGoal;
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  const made = await createGoal({ name: "RP-45 fixture: nota del día", horizon: dayAfter(today, 90) });
  if (!made.ok) throw new Error(`createGoal: ${made.error}`);
  goalId = made.goalId;
  goalIds.push(goalId);
});

after(async () => {
  if (looseIds.length > 0) await sql`delete from goals.one_offs where id in ${sql(looseIds)}`;
  if (goalIds.length > 0) await sql`delete from goals.goals where id in ${sql(goalIds)}`;
  await sql.end();
});

test("loadDay: a noted one-off reads its note pending on its day and done in «hechas hoy»", async () => {
  const pendingId = await created({ name: "RP-45 pendiente", day: today, goalId });
  await noted(pendingId, "nota pendiente");
  const bareId = await created({ name: "RP-45 sin nota", day: today, goalId });
  const doneId = await created({ name: "RP-45 hecha", day: today, goalId });
  await noted(doneId, "nota hecha");
  const completed = await actions.completeOneOff({ oneOffId: doneId });
  assert.equal(completed.ok, true, JSON.stringify(completed));

  const { loadDay } = await import("@/lib/queries/day");
  const loaded = await loadDay(today);
  assert.equal(loaded.oneOffs.find((o) => o.id === pendingId)?.note, "nota pendiente");
  assert.equal(loaded.oneOffs.find((o) => o.id === bareId)?.note, null);
  assert.equal(loaded.doneOneOffs.find((o) => o.id === doneId)?.note, "nota hecha");
});

test("loadDay: the goal's next month task carries its note", async () => {
  const taskId = await created({ name: "RP-45 del mes", day: null, goalId, plannedMonth: today.slice(0, 7) });
  await noted(taskId, "nota del mes");
  const { loadDay } = await import("@/lib/queries/day");
  const loaded = await loadDay(today);
  assert.equal(loaded.monthTask[goalId]?.id, taskId);
  assert.equal(loaded.monthTask[goalId]?.note, "nota del mes");
});

test("listDaylessOneOffs and listScheduledOneOffs: each row carries its note", async () => {
  const daylessId = await created({ name: "RP-45 suelta", day: null });
  looseIds.push(daylessId);
  await noted(daylessId, "nota suelta");
  const scheduledId = await created({ name: "RP-45 agendada", day: dayAfter(today, 3) });
  looseIds.push(scheduledId);
  await noted(scheduledId, "nota agendada");
  const bareId = await created({ name: "RP-45 agendada sin nota", day: dayAfter(today, 4) });
  looseIds.push(bareId);

  const { listDaylessOneOffs, listScheduledOneOffs } = await import("@/lib/queries/one-offs");
  const dayless = await listDaylessOneOffs();
  assert.equal(dayless.find((o) => o.id === daylessId)?.note, "nota suelta");
  const scheduled = await listScheduledOneOffs(today);
  assert.equal(scheduled.find((o) => o.id === scheduledId)?.note, "nota agendada");
  assert.equal(scheduled.find((o) => o.id === bareId)?.note, null);
});
