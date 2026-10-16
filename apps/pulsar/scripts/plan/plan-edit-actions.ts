// Drives the four acts of RP-127 (`app/actions/plan-edit.ts`): `editPhase`, `deletePhase`, `editCadence`,
// `deleteCommitment`. Written from the contract: what no fact depends on can be edited and deleted, what a fact
// names refuses with its key and keeps its row, its fact and its day count; a phase never overlaps its goal's
// others, not even under two concurrent edits. `server-only`, `next/headers` and `next/cache` are stubbed; the
// statements are counted off the driver's own wire; every row is planted by the pooler and deleted by its own id.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

import postgres from "postgres";

import { todayInZone } from "@/lib/zone";
import { wrapPostgres, type DebugCall, type PostgresFactory } from "./wire";

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
let wire: DebugCall[] | null = null;
let standing: StoredCookie[] = [];
let sessionCookies: StoredCookie[];

function installStubs(): void {
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "server-only") return {};
    if (request === "next/headers") {
      return { cookies: async () => ({ getAll: () => standing, set() {} }) };
    }
    if (request === "next/cache") {
      return { revalidatePath: (path: string) => void revalidated.push(path) };
    }
    if (request === "postgres") {
      const real = originalLoad(request, parent, isMain) as PostgresFactory;
      return Object.assign(
        wrapPostgres(real, (call) => wire?.push(call)),
        real,
      );
    }
    return originalLoad(request, parent, isMain);
  };
}

type Acts = typeof import("@/app/actions/plan-edit");
let acts: Acts;
let day: typeof import("@/lib/queries/day");
let goalQuery: typeof import("@/lib/queries/goal");
let habitQuery: typeof import("@/lib/queries/habit");

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, {
  prepare: false,
  max: 1,
  connection: { statement_timeout: 15_000, lock_timeout: 10_000 },
});

const goalIds: string[] = [];
const commitmentIds: string[] = [];
let me: string;
let member: string;

type Row = Record<string, unknown>;

// An open goal far from today; its end leaves room for every span below.
const HORIZON = "2099-12-31";

async function goal(name: string, columns: { horizon?: string | null; archived?: boolean; owner?: string } = {}) {
  const [row] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, archived_at)
    values (${columns.owner ?? me}, ${`RP-127 fixture ${name}`}, ${columns.horizon === undefined ? HORIZON : columns.horizon},
            ${columns.archived ? sql`now()` : null})
    returning id`;
  goalIds.push(row.id);
  return row.id;
}

async function phase(goalId: string, aim: string, startsOn: string, endsOn: string, owner = me): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${owner}, ${goalId}, ${aim}, ${startsOn}::date, ${endsOn}::date) returning id`;
  return row.id;
}

async function phaseRow(id: string): Promise<Row | undefined> {
  const [row] = await sql<Row[]>`
    select aim, starts_on::text as starts_on, ends_on::text as ends_on, goal_id, user_id
    from goals.phases where id = ${id}`;
  return row;
}

type CommitmentColumns = {
  goalId?: string | null;
  owner?: string;
  kind?: string;
  n?: number | null;
  weekdays?: number[] | null;
  retired?: boolean;
  quantity?: boolean;
};

async function commitment(name: string, columns: CommitmentColumns = {}): Promise<string> {
  const kind = columns.kind ?? "times_per_week";
  const n = columns.n === undefined ? (kind === "times_per_week" ? 3 : null) : columns.n;
  const [row] = await sql<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, cadence_weekdays, satisfaction,
                                   target_quantity, unit, retired_at)
    values (${columns.owner ?? me}, ${columns.goalId ?? null}, ${`RP-127 ${name}`}, ${kind}, ${n}, ${columns.weekdays ?? null},
            ${columns.quantity ? "quantity" : "tap"}, ${columns.quantity ? 30 : null}, ${columns.quantity ? "minutos" : null},
            ${columns.retired ? sql`now()` : null})
    returning id`;
  commitmentIds.push(row.id);
  return row.id;
}

async function fact(commitmentId: string, goalId: string | null, factDay: string): Promise<void> {
  await sql`
    insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
    values (${me}, ${commitmentId}, ${goalId}, ${factDay}::date, null)`;
}

async function commitmentRow(id: string): Promise<Row | undefined> {
  const [row] = await sql<Row[]>`
    select name, note, cadence_kind, cadence_n, cadence_weekdays, satisfaction, target_quantity, unit, threshold,
           source_id, created_at, position, retired_at, goal_id
    from goals.commitments where id = ${id}`;
  return row;
}

async function factCount(id: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from goals.facts where commitment_id = ${id}`;
  return row.n;
}

function statements(calls: DebugCall[]): string[] {
  return calls
    .map((call) => call.query.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(
      (q) => !q.startsWith("begin") && q !== "commit" && q !== "rollback" && !q.includes("pg_catalog.pg_type") && !q.includes("set_config("),
    );
}

function begins(calls: DebugCall[]): number {
  return calls.filter((call) => call.query.trim().toLowerCase().startsWith("begin")).length;
}

// Runs one act with the wire and the revalidated paths reset; returns its answer and what it sent.
async function run<T>(act: () => Promise<T>): Promise<{ result: T; calls: DebugCall[]; paths: string[] }> {
  revalidated.length = 0;
  const calls: DebugCall[] = [];
  wire = calls;
  try {
    const result = await act();
    return { result, calls, paths: [...revalidated] };
  } finally {
    wire = null;
  }
}

function assertRevalidated(paths: string[], expected: string[]): void {
  for (const path of expected) assert.ok(paths.includes(path), `${path} not revalidated: ${paths.join(", ")}`);
}

const screens = (goalId: string | null, habitId?: string): string[] => [
  "/",
  "/semana",
  "/mes",
  "/metas",
  ...(goalId ? [`/metas/${goalId}`] : []),
  ...(habitId ? [`/metas/habitos/${habitId}`] : []),
];

const ok = { ok: true };

before(async () => {
  sessionCookies = loadCookies();
  standing = sessionCookies;
  installStubs();
  acts = await import("@/app/actions/plan-edit");
  day = await import("@/lib/queries/day");
  goalQuery = await import("@/lib/queries/goal");
  habitQuery = await import("@/lib/queries/habit");
  const { getPerson } = await import("@/lib/session");
  const person = await getPerson();
  if (!person) throw new Error("the lane's session carries no person");
  me = person.id;
  const memberEmail = `harness-member${laneNumber() === 1 ? "" : `-${laneNumber()}`}@example.invalid`;
  const [other] = await sql<{ id: string }[]>`select id from auth.users where email = ${memberEmail}`;
  if (!other) throw new Error("no lane member identity — run harness:token for this lane from apps/orbit");
  member = other.id;
});

after(async () => {
  try {
    if (commitmentIds.length > 0) await sql`delete from goals.commitments where id in ${sql(commitmentIds)}`;
    if (goalIds.length > 0) await sql`delete from goals.goals where id in ${sql(goalIds)}`;
  } finally {
    await sql.end();
  }
});

// ---------------------------------------------------------------- editPhase

test("editPhase: the aim and the span read back as written, the aim trimmed, and the screens are revalidated", async () => {
  const g = await goal("fase edita");
  const p = await phase(g, "vieja", "2097-01-01", "2097-01-31");
  const { result, paths } = await run(() =>
    acts.editPhase({ phaseId: p, aim: "  Base nueva ", startsOn: "2097-02-02", endsOn: "2097-03-15" }),
  );
  assert.deepEqual(result, ok);
  assert.deepEqual(await phaseRow(p), { aim: "Base nueva", starts_on: "2097-02-02", ends_on: "2097-03-15", goal_id: g, user_id: me });
  assertRevalidated(paths, screens(g));
});

test("editPhase: moving over its own old days is not an overlap, and the same span in another goal is none either", async () => {
  const g = await goal("fase sola");
  const other = await goal("fase de otra meta");
  const p = await phase(g, "sola", "2097-01-01", "2097-01-31");
  await phase(other, "ajena", "2097-04-01", "2097-04-30");
  assert.deepEqual(
    (await run(() => acts.editPhase({ phaseId: p, aim: "sola", startsOn: "2097-01-15", endsOn: "2097-02-15" }))).result,
    ok,
  );
  assert.deepEqual(
    (await run(() => acts.editPhase({ phaseId: p, aim: "sola", startsOn: "2097-04-05", endsOn: "2097-04-20" }))).result,
    ok,
  );
  assert.equal((await phaseRow(p))?.starts_on, "2097-04-05");
});

test("editPhase: a span that shares a day with the goal's other phase is phaseOverlap and the row stays, the boundary day included", async () => {
  const g = await goal("fase solapa");
  const p = await phase(g, "primera", "2097-01-01", "2097-01-31");
  await phase(g, "segunda", "2097-03-01", "2097-03-31");
  const before = await phaseRow(p);
  for (const [startsOn, endsOn] of [
    ["2097-02-10", "2097-03-10"],
    ["2097-02-10", "2097-03-01"],
    ["2097-03-31", "2097-04-30"],
    ["2097-02-01", "2097-04-30"],
  ]) {
    const { result } = await run(() => acts.editPhase({ phaseId: p, aim: "cambiada", startsOn, endsOn }));
    assert.deepEqual(result, { ok: false, error: "plan.errors.phaseOverlap" }, `${startsOn}..${endsOn}`);
    assert.deepEqual(await phaseRow(p), before);
  }
  const free = await run(() => acts.editPhase({ phaseId: p, aim: "libre", startsOn: "2097-02-01", endsOn: "2097-02-28" }));
  assert.deepEqual(free.result, ok);
});

test("editPhase: a span ending after the goal's end is phasePastHorizon and the row stays; ending on it is fine", async () => {
  const g = await goal("fase horizonte", { horizon: "2098-06-30" });
  const p = await phase(g, "dentro", "2098-01-01", "2098-01-31");
  const before = await phaseRow(p);
  const { result } = await run(() => acts.editPhase({ phaseId: p, aim: "pasada", startsOn: "2098-06-01", endsOn: "2098-07-01" }));
  assert.deepEqual(result, { ok: false, error: "plan.errors.phasePastHorizon" });
  assert.deepEqual(await phaseRow(p), before);
  const edge = await run(() => acts.editPhase({ phaseId: p, aim: "justa", startsOn: "2098-06-01", endsOn: "2098-06-30" }));
  assert.deepEqual(edge.result, ok);
});

test("editPhase: an archived goal and an ended goal read as goalNotFound and the phase stays", async () => {
  const archived = await goal("fase archivada", { archived: true });
  const ended = await goal("fase terminada", { horizon: "2020-06-30" });
  for (const g of [archived, ended]) {
    const p = await phase(g, "quieta", "2019-01-01", "2019-01-31");
    const before = await phaseRow(p);
    const { result } = await run(() => acts.editPhase({ phaseId: p, aim: "movida", startsOn: "2019-02-01", endsOn: "2019-02-28" }));
    assert.deepEqual(result, { ok: false, error: "plan.errors.goalNotFound" });
    assert.deepEqual(await phaseRow(p), before);
  }
});

test("editPhase: a missing phase and another person's phase are phaseNotFound, and the other person's row stays", async () => {
  const theirs = await goal("fase ajena", { owner: member });
  const p = await phase(theirs, "de otra", "2097-01-01", "2097-01-31", member);
  const before = await phaseRow(p);
  const foreign = await run(() => acts.editPhase({ phaseId: p, aim: "robada", startsOn: "2097-05-01", endsOn: "2097-05-31" }));
  assert.deepEqual(foreign.result, { ok: false, error: "plan.errors.phaseNotFound" });
  assert.deepEqual(await phaseRow(p), before);
  const missing = await run(() =>
    acts.editPhase({ phaseId: "00000000-0000-4000-8000-000000001012", aim: "x", startsOn: "2097-05-01", endsOn: "2097-05-31" }),
  );
  assert.deepEqual(missing.result, { ok: false, error: "plan.errors.phaseNotFound" });
});

test("editPhase: two edits racing into one free span cannot both land (the goal's lock serialises them)", async () => {
  const g = await goal("fase carrera");
  for (let round = 0; round < 6; round += 1) {
    const year = 2080 + round;
    const x = await phase(g, "x", `${year}-01-01`, `${year}-01-31`);
    const y = await phase(g, "y", `${year}-03-01`, `${year}-03-31`);
    const span = { startsOn: `${year}-05-01`, endsOn: `${year}-05-31` };
    const [a, b] = await Promise.all([
      acts.editPhase({ phaseId: x, aim: "x", ...span }),
      acts.editPhase({ phaseId: y, aim: "y", ...span }),
    ]);
    const answers = [a, b].map((answer) => (answer.ok ? "ok" : answer.error)).sort();
    assert.deepEqual(answers, ["ok", "plan.errors.phaseOverlap"], `round ${round}`);
    const landed = [await phaseRow(x), await phaseRow(y)].filter((row) => row?.starts_on === span.startsOn);
    assert.equal(landed.length, 1, `round ${round}: ${landed.length} phases hold ${span.startsOn}`);
  }
});

test("editPhase: a malformed id is refused before any statement; signed out writes nothing", async () => {
  const g = await goal("fase sin sesión");
  const p = await phase(g, "queda", "2097-01-01", "2097-01-31");
  const bad = await run(() => acts.editPhase({ phaseId: "x", aim: "a", startsOn: "2097-02-01", endsOn: "2097-02-02" }));
  assert.equal(bad.result.ok, false);
  assert.equal(statements(bad.calls).length, 0, statements(bad.calls).join(" | "));
  standing = [];
  const out = await run(() => acts.editPhase({ phaseId: p, aim: "cambiada", startsOn: "2097-02-01", endsOn: "2097-02-02" }));
  standing = sessionCookies;
  assert.deepEqual(out.result, { ok: false, error: "plan.errors.signedOut" });
  assert.equal((await phaseRow(p))?.aim, "queda");
});

// -------------------------------------------------------------- deletePhase

test("deletePhase: the phase is gone, the goal's other phase and the goal stay, the screens are revalidated", async () => {
  const g = await goal("fase borra");
  const gone = await phase(g, "se va", "2097-01-01", "2097-01-31");
  const stays = await phase(g, "queda", "2097-03-01", "2097-03-31");
  const { result, calls, paths } = await run(() => acts.deletePhase({ phaseId: gone }));
  assert.deepEqual(result, ok);
  assert.equal(await phaseRow(gone), undefined);
  assert.equal((await phaseRow(stays))?.aim, "queda");
  assert.equal(begins(calls), 1);
  assertRevalidated(paths, screens(g));
});

test("deletePhase: a missing phase and another person's are phaseNotFound and the other person's stays", async () => {
  const theirs = await goal("fase ajena borra", { owner: member });
  const p = await phase(theirs, "de otra", "2097-01-01", "2097-01-31", member);
  assert.deepEqual((await run(() => acts.deletePhase({ phaseId: p }))).result, { ok: false, error: "plan.errors.phaseNotFound" });
  assert.equal((await phaseRow(p))?.aim, "de otra");
  assert.deepEqual(
    (await run(() => acts.deletePhase({ phaseId: "00000000-0000-4000-8000-000000001012" }))).result,
    { ok: false, error: "plan.errors.phaseNotFound" },
  );
});

test("deletePhase: an archived goal's phase and an ended goal's phase read as goalNotFound and stay", async () => {
  for (const g of [await goal("borra archivada", { archived: true }), await goal("borra terminada", { horizon: "2020-06-30" })]) {
    const p = await phase(g, "queda", "2019-01-01", "2019-01-31");
    assert.deepEqual((await run(() => acts.deletePhase({ phaseId: p }))).result, { ok: false, error: "plan.errors.goalNotFound" });
    assert.equal((await phaseRow(p))?.aim, "queda");
  }
});

test("deletePhase: signed out deletes nothing", async () => {
  const g = await goal("borra sin sesión");
  const p = await phase(g, "queda", "2097-01-01", "2097-01-31");
  standing = [];
  const out = await run(() => acts.deletePhase({ phaseId: p }));
  standing = sessionCookies;
  assert.deepEqual(out.result, { ok: false, error: "plan.errors.signedOut" });
  assert.equal((await phaseRow(p))?.aim, "queda");
});

// -------------------------------------------------------------- editCadence

async function cadenceOnToday(commitmentId: string) {
  const loaded = await day.loadDay(todayInZone());
  return [...loaded.commitments, ...loaded.loose.commitments].find((entry) => entry.id === commitmentId)?.cadence;
}

test("editCadence: a goal's commitment with no fact takes each kind, writes only the cadence columns, and Hoy asks by the new cadence", async () => {
  const g = await goal("cadencia");
  const id = await commitment("cadencia", { goalId: g, quantity: true });
  const kept = (row: Row | undefined) =>
    Object.fromEntries(Object.entries(row ?? {}).filter(([key]) => !key.startsWith("cadence_")));
  const before = await commitmentRow(id);

  const first = await run(() => acts.editCadence({ commitmentId: id, cadenceKind: "weekdays", cadenceWeekdays: [1, 3, 5] }));
  let result = first.result;
  const paths = first.paths;
  assert.deepEqual(result, ok);
  let row = await commitmentRow(id);
  assert.equal(row?.cadence_kind, "weekdays");
  assert.deepEqual(row?.cadence_weekdays, [1, 3, 5]);
  assert.equal(row?.cadence_n, null);
  assert.deepEqual(await cadenceOnToday(id), { kind: "weekdays", days: [1, 3, 5] });
  assertRevalidated(paths, screens(g));

  ({ result } = await run(() => acts.editCadence({ commitmentId: id, cadenceKind: "every_n_days", cadenceN: 10 })));
  assert.deepEqual(result, ok);
  row = await commitmentRow(id);
  assert.equal(row?.cadence_kind, "every_n_days");
  assert.equal(row?.cadence_n, 10);
  assert.equal(row?.cadence_weekdays, null);

  ({ result } = await run(() => acts.editCadence({ commitmentId: id, cadenceKind: "times_per_month", cadenceN: 12 })));
  assert.deepEqual(result, ok);
  assert.deepEqual(await cadenceOnToday(id), { kind: "times_per_month", count: 12 });

  ({ result } = await run(() => acts.editCadence({ commitmentId: id, cadenceKind: "times_per_week", cadenceN: 4 })));
  assert.deepEqual(result, ok);
  assert.deepEqual(await cadenceOnToday(id), { kind: "times_per_week", count: 4 });

  ({ result } = await run(() => acts.editCadence({ commitmentId: id, cadenceKind: "daily" })));
  assert.deepEqual(result, ok);
  row = await commitmentRow(id);
  assert.equal(row?.cadence_kind, "daily");
  assert.equal(row?.cadence_n, null);
  assert.equal(row?.cadence_weekdays, null);
  assert.deepEqual(await cadenceOnToday(id), { kind: "daily" });

  assert.deepEqual(kept(row), kept(before), "name, what satisfies it, its amount, created_at, position and goal never move here");
});

test("editCadence: a commitment a fact names is cadenceHasFacts; the cadence, the fact, its week and its day count stay", async () => {
  const g = await goal("cadencia con hecho");
  const id = await commitment("cadencia con hecho", { goalId: g, kind: "times_per_week", n: 3 });
  const today = todayInZone();
  await fact(id, g, today);
  const before = await commitmentRow(id);
  const weekBefore = (await day.loadDay(today)).periodDone[id];
  const { result } = await run(() => acts.editCadence({ commitmentId: id, cadenceKind: "daily" }));
  assert.deepEqual(result, { ok: false, error: "plan.errors.cadenceHasFacts" });
  assert.deepEqual(await commitmentRow(id), before);
  assert.equal(await factCount(id), 1);
  assert.equal(weekBefore, 1);
  assert.equal((await day.loadDay(today)).periodDone[id], weekBefore);
  const view = await goalQuery.loadGoal(g);
  assert.equal(view?.commitments.find((entry) => entry.id === id)?.factDayCount, 1);
});

test("editCadence: a retired commitment with no fact is commitmentRetired and keeps its cadence", async () => {
  const g = await goal("cadencia retirada");
  const id = await commitment("cadencia retirada", { goalId: g, retired: true });
  const before = await commitmentRow(id);
  const { result } = await run(() => acts.editCadence({ commitmentId: id, cadenceKind: "daily" }));
  assert.deepEqual(result, { ok: false, error: "plan.errors.commitmentRetired" });
  assert.deepEqual(await commitmentRow(id), before);
});

test("editCadence: a missing commitment and another person's are commitmentNotFound and the other person's stays", async () => {
  const id = await commitment("cadencia ajena", { owner: member, kind: "daily", n: null });
  const before = await commitmentRow(id);
  assert.deepEqual(
    (await run(() => acts.editCadence({ commitmentId: id, cadenceKind: "times_per_week", cadenceN: 2 }))).result,
    { ok: false, error: "plan.errors.commitmentNotFound" },
  );
  assert.deepEqual(await commitmentRow(id), before);
  assert.deepEqual(
    (await run(() => acts.editCadence({ commitmentId: "00000000-0000-4000-8000-000000001012", cadenceKind: "daily" }))).result,
    { ok: false, error: "plan.errors.commitmentNotFound" },
  );
});

test("editCadence: eight a week is the RP-12 key at the act and the row stays", async () => {
  const g = await goal("cadencia cota");
  const id = await commitment("cadencia cota", { goalId: g });
  const before = await commitmentRow(id);
  const { result, calls } = await run(() => acts.editCadence({ commitmentId: id, cadenceKind: "times_per_week", cadenceN: 8 }));
  assert.deepEqual(result, { ok: false, error: "plan.errors.timesPerWeekInvalid" });
  assert.equal(statements(calls).length, 0);
  assert.deepEqual(await commitmentRow(id), before);
});

test("editCadence: a loose habit with no fact takes the new cadence, and its own screen reads it", async () => {
  const id = await commitment("hábito suelto", { kind: "times_per_week", n: 2 });
  const { result, paths } = await run(() => acts.editCadence({ commitmentId: id, cadenceKind: "weekdays", cadenceWeekdays: [2, 4] }));
  assert.deepEqual(result, ok);
  assert.deepEqual((await habitQuery.loadHabit(id))?.cadence, { kind: "weekdays", days: [2, 4] });
  assert.deepEqual(await cadenceOnToday(id), { kind: "weekdays", days: [2, 4] });
  assertRevalidated(paths, screens(null, id));
});

test("editCadence: a loose habit a fact names is cadenceHasFacts and keeps its cadence and fact; a retired one is commitmentRetired", async () => {
  const withFact = await commitment("hábito con hecho", { kind: "times_per_week", n: 2 });
  await fact(withFact, null, "2026-01-05");
  const before = await commitmentRow(withFact);
  assert.deepEqual(
    (await run(() => acts.editCadence({ commitmentId: withFact, cadenceKind: "daily" }))).result,
    { ok: false, error: "plan.errors.cadenceHasFacts" },
  );
  assert.deepEqual(await commitmentRow(withFact), before);
  assert.equal(await factCount(withFact), 1);
  assert.deepEqual((await habitQuery.loadHabit(withFact))?.cadence, { kind: "times_per_week", count: 2 });

  const retired = await commitment("hábito retirado", { retired: true });
  assert.deepEqual(
    (await run(() => acts.editCadence({ commitmentId: retired, cadenceKind: "daily" }))).result,
    { ok: false, error: "plan.errors.commitmentRetired" },
  );
});

test("editCadence: signed out writes nothing", async () => {
  const id = await commitment("cadencia sin sesión", { kind: "times_per_week", n: 2 });
  standing = [];
  const out = await run(() => acts.editCadence({ commitmentId: id, cadenceKind: "daily" }));
  standing = sessionCookies;
  assert.deepEqual(out.result, { ok: false, error: "plan.errors.signedOut" });
  assert.equal((await commitmentRow(id))?.cadence_kind, "times_per_week");
});

// --------------------------------------------------------- deleteCommitment

test("deleteCommitment: a goal's commitment with no fact is gone in one statement; its sibling and the goal stay", async () => {
  const g = await goal("borra compromiso");
  const gone = await commitment("se va", { goalId: g });
  const stays = await commitment("queda", { goalId: g });
  await fact(stays, g, "2026-01-05");
  const { result, calls, paths } = await run(() => acts.deleteCommitment({ commitmentId: gone }));
  assert.deepEqual(result, ok);
  assert.equal(await commitmentRow(gone), undefined);
  assert.notEqual(await commitmentRow(stays), undefined);
  assert.equal(await factCount(stays), 1);
  assert.equal(statements(calls).length, 1, statements(calls).join(" | "));
  assert.equal(begins(calls), 1);
  assertRevalidated(paths, screens(g));
});

test("deleteCommitment: a retired commitment no fact names is deleted too", async () => {
  const g = await goal("borra retirado");
  const id = await commitment("retirado", { goalId: g, retired: true });
  assert.deepEqual((await run(() => acts.deleteCommitment({ commitmentId: id }))).result, ok);
  assert.equal(await commitmentRow(id), undefined);
});

test("deleteCommitment: a commitment a fact names is commitmentHasFacts, in one statement; the row, the fact and the day count stay", async () => {
  const g = await goal("borra con hecho");
  const id = await commitment("con hecho", { goalId: g });
  await fact(id, g, "2026-01-05");
  await fact(id, g, "2026-01-06");
  const before = await commitmentRow(id);
  const { result, calls } = await run(() => acts.deleteCommitment({ commitmentId: id }));
  assert.deepEqual(result, { ok: false, error: "plan.errors.commitmentHasFacts" });
  assert.equal(statements(calls).length, 1, statements(calls).join(" | "));
  assert.deepEqual(await commitmentRow(id), before);
  assert.equal(await factCount(id), 2);
  const view = await goalQuery.loadGoal(g);
  assert.equal(view?.commitments.find((entry) => entry.id === id)?.factDayCount, 2);
});

test("deleteCommitment: a loose habit with no fact is deleted and its screen is revalidated; with a fact it stays", async () => {
  const gone = await commitment("hábito se va");
  const { result, paths } = await run(() => acts.deleteCommitment({ commitmentId: gone }));
  assert.deepEqual(result, ok);
  assert.equal(await commitmentRow(gone), undefined);
  assertRevalidated(paths, screens(null, gone));

  const stays = await commitment("hábito queda");
  await fact(stays, null, "2026-01-05");
  assert.deepEqual(
    (await run(() => acts.deleteCommitment({ commitmentId: stays }))).result,
    { ok: false, error: "plan.errors.commitmentHasFacts" },
  );
  assert.notEqual(await commitmentRow(stays), undefined);
  assert.equal((await habitQuery.loadHabit(stays))?.factDayCount, 1);
});

test("deleteCommitment: a missing commitment and another person's are commitmentNotFound and the other person's stays", async () => {
  const id = await commitment("borra ajeno", { owner: member, kind: "daily", n: null });
  assert.deepEqual(
    (await run(() => acts.deleteCommitment({ commitmentId: id }))).result,
    { ok: false, error: "plan.errors.commitmentNotFound" },
  );
  assert.notEqual(await commitmentRow(id), undefined);
  assert.deepEqual(
    (await run(() => acts.deleteCommitment({ commitmentId: "00000000-0000-4000-8000-000000001012" }))).result,
    { ok: false, error: "plan.errors.commitmentNotFound" },
  );
});

test("deleteCommitment: a malformed id is refused before any statement; signed out deletes nothing", async () => {
  const bad = await run(() => acts.deleteCommitment({ commitmentId: "x" }));
  assert.deepEqual(bad.result, { ok: false, error: "plan.errors.commitmentInvalid" });
  assert.equal(statements(bad.calls).length, 0);
  const id = await commitment("borra sin sesión");
  standing = [];
  const out = await run(() => acts.deleteCommitment({ commitmentId: id }));
  standing = sessionCookies;
  assert.deepEqual(out.result, { ok: false, error: "plan.errors.signedOut" });
  assert.notEqual(await commitmentRow(id), undefined);
});

// ------------------------------------------------------- the done criterion

test("one goal, two phases, two commitments one with a fact: the phase edits and deletes, the fact-less commitment changes cadence and deletes, the other refuses both", async () => {
  const g = await goal("criterio");
  const first = await phase(g, "primera", "2097-01-01", "2097-01-31");
  const second = await phase(g, "segunda", "2097-03-01", "2097-03-31");
  const free = await commitment("sin hecho", { goalId: g });
  const held = await commitment("con hecho", { goalId: g, kind: "times_per_week", n: 3 });
  const today = todayInZone();
  await fact(held, g, today);

  assert.deepEqual(
    (await run(() => acts.editPhase({ phaseId: first, aim: "otra", startsOn: "2097-01-10", endsOn: "2097-02-10" }))).result,
    ok,
  );
  assert.deepEqual(await phaseRow(first), { aim: "otra", starts_on: "2097-01-10", ends_on: "2097-02-10", goal_id: g, user_id: me });
  assert.deepEqual((await run(() => acts.deletePhase({ phaseId: first }))).result, ok);
  assert.equal(await phaseRow(first), undefined);
  assert.notEqual(await phaseRow(second), undefined);

  assert.deepEqual((await run(() => acts.editCadence({ commitmentId: free, cadenceKind: "every_n_days", cadenceN: 5 }))).result, ok);
  assert.deepEqual(await cadenceOnToday(free), { kind: "every_n_days", n: 5, anchor: todayInZone() });
  assert.deepEqual((await run(() => acts.deleteCommitment({ commitmentId: free }))).result, ok);

  const before = await commitmentRow(held);
  const weekBefore = (await day.loadDay(today)).periodDone[held];
  assert.deepEqual(
    (await run(() => acts.editCadence({ commitmentId: held, cadenceKind: "daily" }))).result,
    { ok: false, error: "plan.errors.cadenceHasFacts" },
  );
  assert.deepEqual(
    (await run(() => acts.deleteCommitment({ commitmentId: held }))).result,
    { ok: false, error: "plan.errors.commitmentHasFacts" },
  );
  assert.deepEqual(await commitmentRow(held), before);
  assert.equal(await factCount(held), 1);
  assert.equal((await day.loadDay(today)).periodDone[held], weekBefore);
  assert.equal((await goalQuery.loadGoal(g))?.commitments.find((entry) => entry.id === held)?.factDayCount, 1);
});
