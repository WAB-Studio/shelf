// Proves RP-130's act (module 1021): `confirmImport` given `{ draft, updates }` writes, in one transaction, every
// difference the review listed for a goal that matches one open goal, refuses a review the goal changed under,
// and still creates the goals that match none. Written from the contract, not from the implementation.
// The person is an isolated one made by `scripts/mcp/lib/people.ts` and acted as with `actAs`; the review's
// fingerprint is computed the way the review does it, with `differences` and `fingerprint`. No model is called:
// every plan is the app's template, read with no model.
import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, test } from "node:test";

import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, type Person } from "../mcp/lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

const admin = adminSql();
const wire: string[] = [];
const door = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 1,
  debug: (_connection: number, query: string) => void wire.push(query),
});
(globalThis as unknown as { sql: unknown }).sql = door;

const revalidated: string[] = [];
// `server-only` throws outside Next and `next/cache` needs a request.
function installStubs(): void {
  const untyped = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "server-only") return {};
    if (request === "next/cache") return { revalidatePath: (path: string) => void revalidated.push(path) };
    return originalLoad(request, parent, isMain);
  };
}

let session: typeof import("@/lib/session");
let action: typeof import("@/app/actions/import");
let match: typeof import("@/lib/queries/import-match");
let diff: typeof import("@/lib/import/differences");
let template: typeof import("@/lib/import/template");
let todayInZone: typeof import("@/lib/zone").todayInZone;
let draftV2Schema: typeof import("@/lib/import/draft").draftV2Schema;
let draftRefusals: typeof import("@/lib/import/draft").draftRefusals;
let withCutPhases: typeof import("@/lib/import/draft").withCutPhases;
type Draft = import("@/lib/import/draft").ImportDraft;
type Update = { g: number; goalId: string; fingerprint: string };
type Result = Awaited<ReturnType<typeof import("@/app/actions/import").confirmImport>>;

let mine: Person;
let TODAY: string;
let M: (n: number) => string;
let lastDay: (n: number) => string;
const RUN = Date.now().toString(36);
let serial = 0;
const fresh = (label: string) => `${label} ${RUN}-${++serial}`;

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  action = await import("@/app/actions/import");
  match = await import("@/lib/queries/import-match");
  diff = await import("@/lib/import/differences");
  template = await import("@/lib/import/template");
  ({ todayInZone } = await import("@/lib/zone"));
  ({ draftV2Schema, draftRefusals, withCutPhases } = await import("@/lib/import/draft"));
  TODAY = todayInZone();
  const base = TODAY.slice(0, 7);
  M = (n) => {
    const [year, month] = base.split("-").map(Number);
    const index = year * 12 + (month - 1) + n;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
  };
  lastDay = (n) => {
    const [year, month] = M(n + 1).split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10);
  };
  const runId = await openCheckRun(admin);
  [mine] = await createPeople(admin, runId, door, 1);
});

after(async () => {
  try {
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

const asMe = <T>(fn: () => Promise<T>) =>
  session.actAs({ id: mine.id, email: mine.email } as ResolvedPerson, fn);

// ---- fixtures -------------------------------------------------------------------------------------------------

type GoalSeed = {
  horizon?: string | null;
  note?: string | null;
  measure?: [string, string] | null;
  rhythm?: number | null;
  createdAt?: string;
  archived?: boolean;
  parentId?: string | null;
};

async function seedGoal(name: string, o: GoalSeed = {}): Promise<string> {
  const measure = o.measure === undefined ? (["Estudio", "minutos"] as [string, string]) : o.measure;
  const [row] = await admin<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, note, measure_name, measure_unit, rhythm, position, parent_id,
                             created_at, archived_at)
    values (${mine.id}, ${name}, ${o.horizon === undefined ? `${M(12)}-01` : o.horizon}, ${o.note ?? null},
            ${measure?.[0] ?? null}, ${measure?.[1] ?? null}, ${o.rhythm ?? null}, ${1000 + serial * 50 + Math.floor(Math.random() * 40)},
            ${o.parentId ?? null}, ${o.createdAt ?? new Date().toISOString()}, ${o.archived ? new Date().toISOString() : null})
    returning id`;
  return row.id;
}

const seedBudget = (goalId: string, month: string, amount: number) =>
  admin`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${mine.id}, ${goalId}, ${`${month}-01`}::date, ${amount})`;

const seedPhase = (goalId: string, aim: string, from: string, to: string) =>
  admin`insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on) values (${mine.id}, ${goalId}, ${aim}, ${from}::date, ${to}::date)`;

async function seedCommitment(goalId: string, name: string, kind: string, o: { weekdays?: number[]; n?: number; qty?: number; unit?: string; position: number }) {
  const [row] = await admin<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_weekdays, cadence_n, satisfaction, target_quantity, unit, position)
    values (${mine.id}, ${goalId}, ${name}, ${kind}, ${o.weekdays ? admin.array(o.weekdays, 21) : null}, ${o.n ?? null},
            ${o.qty ? "quantity" : "tap"}, ${o.qty ?? null}, ${o.unit ?? null}, ${o.position})
    returning id`;
  return row.id;
}

const seedFact = (goalId: string, o: { commitmentId?: string; oneOffId?: string; quantity?: number }) =>
  admin`insert into goals.facts (user_id, goal_id, commitment_id, one_off_id, day, quantity)
        values (${mine.id}, ${goalId}, ${o.commitmentId ?? null}, ${o.oneOffId ?? null}, ${TODAY}::date, ${o.quantity ?? null})`;

async function seedTask(goalId: string, name: string, month: string, estimate: number | null, position: number, parentId: string | null = null) {
  const [row] = await admin<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, estimate, planned_month, in_plan, parent_id, position)
    values (${mine.id}, ${goalId}, ${name}, ${estimate}, ${parentId ? null : `${month}-01`}::date, true, ${parentId}, ${position})
    returning id`;
  return row.id;
}

type GoalText = {
  name: string;
  horizon?: string;
  inside?: string;
  note?: string;
  measure?: string;
  rhythm?: string;
  phases?: string[];
  months?: string[];
  commitments?: string[];
  tasks?: string[];
};

function goalText(g: GoalText): string {
  const lines = [`# ${g.name}`];
  if (g.horizon) lines.push(`horizonte: ${g.horizon}`);
  if (g.inside) lines.push(`dentro de: ${g.inside}`);
  if (g.measure) lines.push(`medida: ${g.measure}`);
  if (g.rhythm) lines.push(`ritmo: ${g.rhythm}`);
  if (g.note) lines.push(`nota: ${g.note}`);
  for (const [title, list] of [["Fases", g.phases], ["Meses", g.months], ["Compromisos", g.commitments], ["Tareas", g.tasks]] as const) {
    if (list && list.length > 0) lines.push("", `## ${title}`, ...list.map((l) => (l.startsWith("  ") ? l : `- ${l}`)));
  }
  return lines.join("\n");
}

function draftOf(...goals: GoalText[]): Draft {
  const parsed = template.parseTemplate(`pulsar · plantilla 2\n\n${goals.map(goalText).join("\n\n")}\n`);
  if (!parsed.matched || "error" in parsed) throw new Error(`the template did not parse: ${JSON.stringify(parsed)}`);
  return validated(parsed.draft);
}

// A fixture the act itself would refuse for another reason proves nothing about the act.
function validated(draft: Draft): Draft {
  const parsed = draftV2Schema.safeParse(draft);
  if (!parsed.success) throw new Error(`fixture is no draft: ${JSON.stringify(parsed.error.issues)}`);
  const refusals = draftRefusals(withCutPhases(parsed.data, TODAY), TODAY);
  if (refusals.length > 0) throw new Error(`fixture is refused: ${JSON.stringify(refusals)}`);
  return draft;
}

// What the review sends: for each draft goal with exactly one open match, the fingerprint of its differences.
async function review(draft: Draft): Promise<Update[]> {
  const snapshots = await asMe(() => match.loadImportSnapshots(draft.goals.map((g) => g.name)));
  const out: Update[] = [];
  for (const { g, match: found } of diff.matchGoals(draft, snapshots)) {
    if (found === null || found === "ambiguous") continue;
    out.push({ g, goalId: found.id, fingerprint: diff.fingerprint(diff.differences(draft.goals[g], found, TODAY)) });
  }
  return out;
}

const confirm = (draft: Draft, updates: Update[]): Promise<Result> =>
  asMe(() => action.confirmImport({ draft, updates }));

// Every row the person owns, to prove "nothing written".
async function world(): Promise<string> {
  const rows = await admin`
    select 'goal' as t, to_jsonb(g) as r from goals.goals g where user_id = ${mine.id}
    union all select 'budget', to_jsonb(b) from goals.month_budgets b where user_id = ${mine.id}
    union all select 'phase', to_jsonb(p) from goals.phases p where user_id = ${mine.id}
    union all select 'commitment', to_jsonb(c) from goals.commitments c where user_id = ${mine.id}
    union all select 'task', to_jsonb(o) from goals.one_offs o where user_id = ${mine.id}
    union all select 'fact', to_jsonb(f) from goals.facts f where user_id = ${mine.id}`;
  return JSON.stringify(rows.map((r) => `${r.t}:${JSON.stringify(r.r)}`).sort());
}

const goalRow = async (id: string) =>
  (await admin<{ horizon: string | null; note: string | null; measure_name: string | null; measure_unit: string | null; rhythm: number | null; parent_id: string | null }[]>`
    select horizon::text as horizon, note, measure_name, measure_unit, rhythm, parent_id from goals.goals where id = ${id}`)[0];

function ok(result: Result): Extract<Result, { ok: true }> {
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  return result as Extract<Result, { ok: true }>;
}

// ---- the done criterion ---------------------------------------------------------------------------------------

test("a matched goal is updated and an unmatched one created, in one transaction", async () => {
  const leer = fresh("Leer");
  const nueva = fresh("Nueva");
  const id = await seedGoal(leer, { note: "vieja" });
  await seedBudget(id, M(1), 90);
  const draft = draftOf(
    { name: leer, horizon: `${M(12)}-01`, note: "nueva", measure: "Estudio · minutos", months: [`${M(1)} · 120 min`], phases: [`${M(2)}-01 a ${lastDay(2)} · Fase nueva`], tasks: [`${M(1)} · 30 min · Tarea nueva`] },
    { name: nueva, horizon: `${M(12)}-01`, note: "una nota", measure: "Estudio · minutos", months: [`${M(1)} · 60 min`], phases: [`${M(2)}-01 a ${lastDay(2)} · Primera`], commitments: ["Repasar · cada día · toque"], tasks: [`${M(1)} · 15 min · Hacer`] },
  );
  const updates = await review(draft);
  assert.deepEqual(updates.map((u) => u.g), [0]);

  wire.length = 0;
  const result = ok(await confirm(draft, updates));
  const calls = wire.map((q) => q.trim().toLowerCase());
  assert.equal(calls.filter((q) => q === "begin").length, 1, "one begin");
  assert.equal(calls.filter((q) => q === "commit").length, 1, "one commit");

  assert.deepEqual(result.updatedIds, [id]);
  assert.equal(result.failed.length, 0);
  assert.equal((await goalRow(id)).note, "nueva");
  const [{ count }] = await admin<{ count: number }[]>`select count(*)::int as count from goals.goals where user_id = ${mine.id} and name = ${leer}`;
  assert.equal(count, 1, "the matched goal is not created again");
  const [{ added }] = await admin<{ added: number }[]>`select count(*)::int as added from goals.one_offs where goal_id = ${id} and name = 'Tarea nueva'`;
  assert.equal(added, 1);

  const [created] = await admin<{ id: string; note: string | null }[]>`select id, note from goals.goals where user_id = ${mine.id} and name = ${nueva}`;
  assert.ok(created, "the unmatched goal exists");
  assert.equal(created.note, "una nota");
  assert.ok(result.goalIds.includes(created.id));
  assert.equal(result.goalIds.includes(id), false, "goalIds lists the goals created, not the ones updated");
  const kids = await admin`
    select (select count(*) from goals.phases where goal_id = ${created.id})::int as phases,
           (select count(*) from goals.month_budgets where goal_id = ${created.id})::int as months,
           (select count(*) from goals.commitments where goal_id = ${created.id})::int as commitments,
           (select count(*) from goals.one_offs where goal_id = ${created.id})::int as tasks`;
  assert.deepEqual({ ...kids[0] }, { phases: 1, months: 1, commitments: 1, tasks: 1 });
});

test("a draft with no updates still creates every goal and touches no existing one", async () => {
  const name = fresh("Sola");
  const draft = draftOf({ name, horizon: `${M(12)}-01` });
  const result = ok(await asMe(() => action.confirmImport(draft)));
  assert.equal(result.goalIds.length, 1);
  assert.deepEqual(result.updatedIds ?? [], []);
});

// ---- one kind of difference at a time -------------------------------------------------------------------------

test("horizon: a later end is written", async () => {
  const name = fresh("Horizonte");
  const id = await seedGoal(name, { horizon: `${M(8)}-01` });
  const draft = draftOf({ name, horizon: `${M(12)}-01` });
  const result = ok(await confirm(draft, await review(draft)));
  assert.deepEqual(result.updatedIds, [id]);
  assert.equal((await goalRow(id)).horizon, `${M(12)}-01`);
});

test("horizon: one that ends before a phase the plan does not mention is listed as failed and the rest lands (RP-25, RP-90)", async () => {
  const name = fresh("Horizonte corto");
  const id = await seedGoal(name, { horizon: `${M(12)}-01`, note: "vieja" });
  await seedPhase(id, "Intocada", `${M(4)}-01`, lastDay(5));
  const draft = draftOf({ name, horizon: `${M(3)}-01`, note: "nueva" });
  const result = ok(await confirm(draft, await review(draft)));
  assert.ok(result.failed.length >= 1, "the refused horizon is listed");
  assert.ok(result.failed.every((f) => f.path.startsWith("goals.0")));
  const row = await goalRow(id);
  assert.equal(row.horizon, `${M(12)}-01`, "the horizon stays");
  assert.equal(row.note, "nueva", "the note lands");
});

test("horizon: one past the end of the goal above is listed as failed and the rest lands (RP-79, RP-90)", async () => {
  const mother = fresh("Madre");
  const motherId = await seedGoal(mother, { horizon: `${M(12)}-01`, note: "vieja" });
  await seedGoal(fresh("Hija de la madre"), { horizon: `${M(10)}-01`, parentId: motherId });
  const draft = draftOf({ name: mother, horizon: `${M(6)}-01`, note: "nueva" });
  const result = ok(await confirm(draft, await review(draft)));
  assert.ok(result.failed.length >= 1);
  const row = await goalRow(motherId);
  assert.equal(row.horizon, `${M(12)}-01`);
  assert.equal(row.note, "nueva");
});

test("note: replaced", async () => {
  const name = fresh("Nota");
  const id = await seedGoal(name, { note: "vieja" });
  const draft = draftOf({ name, horizon: `${M(12)}-01`, note: "la nota nueva" });
  ok(await confirm(draft, await review(draft)));
  assert.equal((await goalRow(id)).note, "la nota nueva");
});

test("measure: one no fact feeds is changed by name; the rhythm and the amounts stay", async () => {
  const name = fresh("Medida");
  const id = await seedGoal(name, { rhythm: 600 });
  await seedBudget(id, M(2), 90);
  const draft = draftOf({ name, horizon: `${M(12)}-01`, measure: "Lectura · minutos" });
  ok(await confirm(draft, await review(draft)));
  const row = await goalRow(id);
  assert.deepEqual([row.measure_name, row.measure_unit, row.rhythm], ["Lectura", "minutos", 600]);
  const [{ count }] = await admin<{ count: number }[]>`select count(*)::int as count from goals.month_budgets where goal_id = ${id}`;
  assert.equal(count, 1);
});

test("measure: a new unit clears the rhythm and the amounts written in the old one, as changeGoalMeasure does", async () => {
  const name = fresh("Unidad");
  const id = await seedGoal(name, { rhythm: 600 });
  await seedBudget(id, M(2), 90);
  const draft = draftOf({ name, horizon: `${M(12)}-01`, measure: "Lectura · páginas" });
  ok(await confirm(draft, await review(draft)));
  const row = await goalRow(id);
  assert.deepEqual([row.measure_name, row.measure_unit, row.rhythm], ["Lectura", "páginas", null]);
  const [{ count }] = await admin<{ count: number }[]>`select count(*)::int as count from goals.month_budgets where goal_id = ${id}`;
  assert.equal(count, 0);
});

test("measure: one a fact feeds stays, is listed as failed, and the rest lands", async () => {
  const name = fresh("Medida alimentada");
  const id = await seedGoal(name, { note: "vieja" });
  const commitment = await seedCommitment(id, "Estudiar", "daily", { qty: 30, unit: "minutos", position: 1 });
  await seedFact(id, { commitmentId: commitment, quantity: 25 });
  const draft = draftOf({ name, horizon: `${M(12)}-01`, measure: "Lectura · minutos", note: "nueva" });
  const result = ok(await confirm(draft, await review(draft)));
  const row = await goalRow(id);
  assert.deepEqual([row.measure_name, row.measure_unit], ["Estudio", "minutos"]);
  assert.equal(row.note, "nueva");
  assert.ok(result.failed.length >= 1 && result.failed.every((f) => f.path.startsWith("goals.0")));
});

test("rhythm: changed, and the closed months keep what they were planned at (RP-76)", async () => {
  const name = fresh("Ritmo");
  const id = await seedGoal(name, { rhythm: 600, createdAt: `${M(-3)}-10T12:00:00Z` });
  await seedBudget(id, M(-1), 111);
  const draft = draftOf({ name, horizon: `${M(12)}-01`, measure: "Estudio · minutos", rhythm: "12 h" });
  ok(await confirm(draft, await review(draft)));
  assert.equal((await goalRow(id)).rhythm, 720);
  const months = await admin<{ month: string; amount: number }[]>`
    select to_char(month, 'YYYY-MM') as month, amount from goals.month_budgets where goal_id = ${id} order by month`;
  const byMonth = new Map(months.map((m) => [m.month, m.amount]));
  assert.equal(byMonth.get(M(-2)), 600, "a closed month with no amount is frozen at the old rhythm");
  assert.equal(byMonth.get(M(-1)), 111, "an amount that was set stays");
  assert.equal(byMonth.has(M(0)), false, "the open month is not frozen");
});

test("months: an open month is upserted, a new one added, the others stay", async () => {
  const name = fresh("Meses");
  const id = await seedGoal(name);
  await seedBudget(id, M(0), 100);
  await seedBudget(id, M(1), 90);
  await seedBudget(id, M(4), 40);
  const draft = draftOf({ name, horizon: `${M(12)}-01`, measure: "Estudio · minutos", months: [`${M(0)} · 150 min`, `${M(1)} · 90 min`, `${M(2)} · 70 min`] });
  ok(await confirm(draft, await review(draft)));
  const rows = await admin<{ month: string; amount: number }[]>`
    select to_char(month, 'YYYY-MM') as month, amount from goals.month_budgets where goal_id = ${id} order by month`;
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { month: M(0), amount: 150 },
    { month: M(1), amount: 90 },
    { month: M(2), amount: 70 },
    { month: M(4), amount: 40 },
  ]);
});

test("phases: a new one is inserted, one of the same aim has its span updated, the one the plan omits stays", async () => {
  const name = fresh("Fases");
  const id = await seedGoal(name);
  await seedPhase(id, "Base", `${M(1)}-01`, lastDay(2));
  await seedPhase(id, "Intocada", `${M(4)}-01`, lastDay(5));
  const [{ id: baseId }] = await admin<{ id: string }[]>`select id from goals.phases where goal_id = ${id} and aim = 'Base'`;
  const draft = draftOf({
    name,
    horizon: `${M(12)}-01`,
    phases: [`${M(1)}-01 a ${lastDay(3)} · Base`, `${M(6)}-01 a ${lastDay(7)} · Nueva`],
  });
  ok(await confirm(draft, await review(draft)));
  const rows = await admin<{ id: string; aim: string; starts_on: string; ends_on: string }[]>`
    select id, aim, starts_on::text, ends_on::text from goals.phases where goal_id = ${id} order by starts_on`;
  assert.deepEqual(rows.map((r) => [r.aim, r.starts_on, r.ends_on]), [
    ["Base", `${M(1)}-01`, lastDay(3)],
    ["Intocada", `${M(4)}-01`, lastDay(5)],
    ["Nueva", `${M(6)}-01`, lastDay(7)],
  ]);
  assert.equal(rows[0].id, baseId, "the span is updated, the phase is not replaced");
});

test("commitments: a fact-less one takes the new cadence, a new one is added, the one the plan omits stays", async () => {
  const name = fresh("Compromisos");
  const id = await seedGoal(name);
  const hojear = await seedCommitment(id, "Hojear", "weekdays", { weekdays: [1, 3], position: 1 });
  await seedCommitment(id, "Quieta", "daily", { position: 2 });
  const draft = draftOf({
    name,
    horizon: `${M(12)}-01`,
    commitments: ["Hojear · martes y jueves · toque", "Nueva · cada día · toque"],
  });
  ok(await confirm(draft, await review(draft)));
  const rows = await admin<{ id: string; name: string; cadence_kind: string; cadence_weekdays: number[] | null; retired_at: string | null }[]>`
    select id, name, cadence_kind, cadence_weekdays, retired_at::text from goals.commitments where goal_id = ${id} order by name`;
  assert.deepEqual(rows.map((r) => [r.name, r.retired_at]), [["Hojear", null], ["Nueva", null], ["Quieta", null]]);
  const hojearRow = rows.find((r) => r.name === "Hojear")!;
  assert.equal(hojearRow.id, hojear, "updated in place");
  assert.equal(hojearRow.cadence_kind, "weekdays");
  assert.deepEqual([...(hojearRow.cadence_weekdays ?? [])], [2, 4]);
});

test("commitments: one with facts and another cadence is retired with its facts intact and a live one is opened (RP-127)", async () => {
  const name = fresh("Compromiso con hechos");
  const id = await seedGoal(name);
  const old = await seedCommitment(id, "Estudiar", "daily", { position: 1 });
  await seedFact(id, { commitmentId: old });
  const draft = draftOf({ name, horizon: `${M(12)}-01`, commitments: ["Estudiar · 3 veces por semana · toque"] });
  const result = ok(await confirm(draft, await review(draft)));
  assert.equal(result.failed.length, 0);
  const rows = await admin<{ id: string; cadence_kind: string; cadence_n: number | null; retired_at: string | null; facts: number }[]>`
    select c.id, c.cadence_kind, c.cadence_n, c.retired_at::text,
           (select count(*)::int from goals.facts f where f.commitment_id = c.id) as facts
    from goals.commitments c where c.goal_id = ${id} order by c.created_at, c.id`;
  assert.equal(rows.length, 2);
  const retired = rows.find((r) => r.id === old)!;
  assert.ok(retired.retired_at, "the old one is retired");
  assert.equal(retired.cadence_kind, "daily", "its cadence is not rewritten");
  assert.equal(retired.facts, 1, "its facts stay on it");
  const live = rows.find((r) => r.id !== old)!;
  assert.equal(live.retired_at, null);
  assert.deepEqual([live.cadence_kind, live.cadence_n], ["times_per_week", 3]);
});

test("tasks: a changed one is updated, a done one is not, new ones go after the last in plan order, sub-tasks go under the matched parent", async () => {
  const name = fresh("Tareas");
  const id = await seedGoal(name);
  const capitulo = await seedTask(id, "Capítulo", M(1), 60, 1);
  const libro = await seedTask(id, "Libro", M(1), null, 2);
  await seedTask(id, "Resumen", M(1), null, 3, libro);
  const hecha = await seedTask(id, "Hecha", M(1), 30, 4);
  await seedFact(id, { oneOffId: hecha });
  await seedTask(id, "Omitida", M(1), 10, 5);
  const draft = draftOf({
    name,
    horizon: `${M(12)}-01`,
    measure: "Estudio · minutos",
    tasks: [
      `${M(2)} · 90 min · Capítulo`,
      `${M(1)} · Libro`,
      "  - Resumen",
      "  - Fichas",
      `${M(2)} · 99 min · Hecha`,
      `${M(1)} · 15 min · Nueva A`,
      `${M(1)} · 20 min · Nueva B`,
    ],
  });
  ok(await confirm(draft, await review(draft)));
  const rows = await admin<{ id: string; name: string; estimate: number | null; planned_month: string | null; parent_id: string | null; position: number; goal_id: string }[]>`
    select id, name, estimate, to_char(planned_month, 'YYYY-MM') as planned_month, parent_id, position, goal_id
    from goals.one_offs where goal_id = ${id}`;
  const by = (n: string) => rows.filter((r) => r.name === n);
  assert.deepEqual([by("Capítulo")[0].id, by("Capítulo")[0].estimate, by("Capítulo")[0].planned_month], [capitulo, 90, M(2)]);
  assert.deepEqual([by("Hecha")[0].estimate, by("Hecha")[0].planned_month], [30, M(1)], "a done task is left as it is");
  assert.equal(by("Omitida").length, 1);
  assert.equal(by("Resumen").length, 1, "an existing sub-task is not added again");
  assert.equal(by("Fichas").length, 1);
  assert.equal(by("Fichas")[0].parent_id, libro);
  assert.equal(by("Fichas")[0].goal_id, id);
  assert.equal(by("Libro").length, 1);
  const [a, b] = [by("Nueva A")[0], by("Nueva B")[0]];
  assert.ok(a && b, "both new tasks exist");
  assert.equal(a.goal_id, id);
  assert.deepEqual([a.estimate, a.planned_month, b.estimate], [15, M(1), 20]);
  const before = Math.max(...rows.filter((r) => ["Capítulo", "Libro", "Resumen", "Hecha", "Omitida"].includes(r.name)).map((r) => r.position));
  assert.ok(a.position > before, "new tasks go after the goal's last (RP-47)");
  assert.ok(b.position > a.position, "in the plan's order");
});

test("a child goal of a matched goal in the draft is created under the matched goal's id", async () => {
  const mother = fresh("Madre matriz");
  const child = fresh("Hija nueva");
  const motherId = await seedGoal(mother, { note: "vieja", measure: null });
  const draft = draftOf(
    { name: mother, horizon: `${M(12)}-01`, note: "nueva" },
    { name: child, horizon: `${M(6)}-01`, inside: mother },
  );
  const updates = await review(draft);
  assert.deepEqual(updates.map((u) => u.g), [0]);
  const result = ok(await confirm(draft, updates));
  assert.equal(result.goalIds.length, 1);
  const [row] = await admin<{ parent_id: string | null }[]>`select parent_id from goals.goals where id = ${result.goalIds[0]}`;
  assert.equal(row.parent_id, motherId);
  assert.equal((await goalRow(motherId)).note, "nueva");
});

// ---- the refusals ---------------------------------------------------------------------------------------------

async function staleCase(label: string, change: (id: string, name: string) => Promise<void>) {
  const name = fresh(label);
  const other = fresh("Nueva de la revisión");
  const id = await seedGoal(name, { note: "vieja" });
  await seedBudget(id, M(1), 90);
  const draft = draftOf(
    { name, horizon: `${M(12)}-01`, note: "nueva", measure: "Estudio · minutos", months: [`${M(1)} · 120 min`] },
    { name: other, horizon: `${M(12)}-01` },
  );
  const updates = await review(draft);
  await change(id, name);
  const before = await world();
  const result = await confirm(draft, updates);
  assert.deepEqual(result, { ok: false, error: "import.errors.reviewStale", at: "goals.0" });
  assert.equal(await world(), before, "nothing is written, the new goal included");
}

test("stale: an amount that changed after the review (the difference is gone) is refused and nothing is written", async () => {
  await staleCase("Cambió el monto", (id) => admin`update goals.month_budgets set amount = 120 where goal_id = ${id}`.then(() => undefined));
});

test("stale: a part added after the review that changes what the plan leaves out is refused", async () => {
  await staleCase("Cambió lo que queda", (id) => seedPhase(id, "Extra", `${M(4)}-01`, lastDay(4)).then(() => undefined));
});

test("stale: a second open goal of the name opened meanwhile makes the match ambiguous and is refused", async () => {
  await staleCase("Ambigua", async (_id, name) => {
    await seedGoal(`  ${name.toLowerCase()} `);
  });
});

test("stale: a goal archived meanwhile no longer matches and is refused", async () => {
  await staleCase("Archivada", (id) => admin`update goals.goals set archived_at = now() where id = ${id}`.then(() => undefined));
});

test("stale: a goalId that is not the goal the name matches is refused", async () => {
  const name = fresh("Otra id");
  const wrong = await seedGoal(fresh("Otra meta"));
  await seedGoal(name, { note: "vieja" });
  const draft = draftOf({ name, horizon: `${M(12)}-01`, note: "nueva" });
  const [update] = await review(draft);
  const before = await world();
  const result = await confirm(draft, [{ ...update, goalId: wrong }]);
  assert.deepEqual(result, { ok: false, error: "import.errors.reviewStale", at: "goals.0" });
  assert.equal(await world(), before);
});

test("a matched goal the review did not send as an update is never changed", async () => {
  const name = fresh("Sin confirmar");
  const id = await seedGoal(name, { note: "vieja" });
  await seedBudget(id, M(1), 90);
  const draft = draftOf({ name, horizon: `${M(12)}-01`, note: "nueva", measure: "Estudio · minutos", months: [`${M(1)} · 120 min`] });
  await asMe(() => action.confirmImport({ draft, updates: [] }));
  const row = await goalRow(id);
  assert.equal(row.note, "vieja");
  const [budget] = await admin<{ amount: number }[]>`select amount from goals.month_budgets where goal_id = ${id}`;
  assert.equal(budget.amount, 90);
});

// ---- one transaction -------------------------------------------------------------------------------------------

test("a failure after the updates rolls the updates back, and one before them leaves no goal created", async () => {
  // Postgres refuses a NUL in text with 22021, a class the part-level fallback does not catch (RP-90).
  const bad = "roto\u0000roto";

  // Control: the same shape without the NUL lands, so the rollbacks below are not a refusal of something else.
  const e = fresh("Control");
  const f = fresh("Control nueva");
  const idE = await seedGoal(e, { note: "vieja" });
  const control = draftOf({ name: e, horizon: `${M(12)}-01`, note: "nueva" }, { name: f, horizon: `${M(12)}-01` });
  ok(await confirm(control, await review(control)));
  assert.equal((await goalRow(idE)).note, "nueva");

  const a = fresh("Se revierte");
  const b = fresh("Falla al crear");
  const idA = await seedGoal(a, { note: "vieja" });
  const draftA = draftOf({ name: a, horizon: `${M(12)}-01`, note: "nueva" }, { name: b, horizon: `${M(12)}-01` });
  draftA.goals[1].note = bad;
  const updatesA = await review(draftA);
  await assert.rejects(() => confirm(draftA, updatesA).then((r) => (r.ok ? Promise.resolve() : Promise.reject(new Error(r.error)))));
  assert.equal((await goalRow(idA)).note, "vieja", "the update did not outlive the failed creation");

  const c = fresh("Falla al actualizar");
  const d = fresh("No debe crearse");
  const idC = await seedGoal(c, { note: "vieja" });
  const draftC = draftOf({ name: c, horizon: `${M(12)}-01`, note: "nueva" }, { name: d, horizon: `${M(12)}-01` });
  draftC.goals[0].note = bad;
  const updatesC = await review(draftC);
  await assert.rejects(() => confirm(draftC, updatesC).then((r) => (r.ok ? Promise.resolve() : Promise.reject(new Error(r.error)))));
  const [{ count }] = await admin<{ count: number }[]>`select count(*)::int as count from goals.goals where user_id = ${mine.id} and name = ${d}`;
  assert.equal(count, 0, "the new goal did not outlive the failed update");
  assert.equal((await goalRow(idC)).note, "vieja");
});

// ---- the statement bound ---------------------------------------------------------------------------------------

async function statementsFor(count: number): Promise<number> {
  const goals: GoalText[] = [];
  for (let i = 0; i < count; i += 1) {
    const name = fresh(`Lote${count}`);
    const id = await seedGoal(name, { note: "vieja" });
    await seedBudget(id, M(1), 90);
    await seedPhase(id, "Base", `${M(1)}-01`, lastDay(1));
    await seedCommitment(id, "Hojear", "weekdays", { weekdays: [1, 3], position: 1 });
    await seedTask(id, "Capítulo", M(1), 60, 1);
    goals.push({
      name,
      horizon: `${M(12)}-01`,
      note: "nueva",
      measure: "Estudio · minutos",
      months: [`${M(1)} · 120 min`],
      phases: [`${M(1)}-01 a ${lastDay(2)} · Base`, `${M(3)}-01 a ${lastDay(3)} · Otra`],
      commitments: ["Hojear · martes y jueves · toque", "Nuevo · cada día · toque"],
      tasks: [`${M(2)} · 90 min · Capítulo`, `${M(1)} · 10 min · Añadida`],
    });
  }
  const draft = draftOf(...goals);
  const updates = await review(draft);
  assert.equal(updates.length, count);
  wire.length = 0;
  const result = ok(await confirm(draft, updates));
  assert.equal(result.updatedIds.length, count);
  assert.equal(result.failed.length, 0);
  return wire.map((q) => q.trim().toLowerCase()).filter((q) => q !== "begin" && q !== "commit" && !q.includes("pg_catalog.pg_type")).length;
}

test("the statements for 20 matched goals equal the statements for 1", async () => {
  const one = await statementsFor(1);
  const twenty = await statementsFor(20);
  console.log(`# statements for 1 matched goal = ${one}, for 20 = ${twenty}`);
  assert.equal(twenty, one);
});
