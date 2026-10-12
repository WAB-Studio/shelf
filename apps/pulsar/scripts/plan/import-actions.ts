// Drives `confirmImport` (`app/actions/import.ts`, RP-37) the way
// `budget-actions.ts` drives its actions: the action imported as a plain
// async function, `server-only`, `next/headers` and `next/cache` stubbed before
// the first `@/` import, the cookie `harness:mint-session` left standing as the
// session, and the pool's wire read for the statement count. Every date is
// built from the real `todayInZone()`: the template's example plans from this
// month to twelve months out, so the suite never goes stale. Rows are read back
// through the pooler, and as a second person under the `authenticated` role.
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

type WireCall = { connection: number; query: string };
let wire: WireCall[] | null = null;

type PostgresFactory = (url: string, options: Record<string, unknown>) => unknown;

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
    // `db/client.ts` is the only `@/` importer of `postgres` before any test
    // body runs; its pool is the one every statement of the action leaves on.
    if (request === "postgres") {
      const real = originalLoad(request, parent, isMain) as PostgresFactory;
      const wrapped: PostgresFactory = (url, options) =>
        real(url, {
          ...options,
          debug: (connection: number, query: string) => {
            wire?.push({ connection, query });
          },
        });
      return Object.assign(wrapped, real);
    }
    return originalLoad(request, parent, isMain);
  };
}

let confirmImport: typeof import("@/app/actions/import").confirmImport;
let todayInZone: typeof import("@/lib/zone").todayInZone;
let parseTemplate: typeof import("@/lib/import/template").parseTemplate;
type Draft = import("@/lib/import/draft").ImportDraftV1;

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, {
  prepare: false,
  max: 1,
  connection: { statement_timeout: 15_000, lock_timeout: 10_000 },
});

const goalIds: string[] = [];
let personId: string;
let otherId: string;

// Calendar helpers on `YYYY-MM` and `YYYY-MM-DD` strings, by midday UTC.
function addMonths(month: string, delta: number): string {
  const [year, m] = month.split("-").map(Number);
  const index = year * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(date);
}

let TODAY: string;
// This month and the months the fixtures name, all relative to `TODAY`.
let M0: string;
let M1: string;
let M2: string;
let M3: string;
let M6: string;
let M12: string;
let M14: string;
let EXAMPLE: string;

// `docs/pulsar/PLANTILLA.md`'s example, its dates moved to follow today.
function exampleText(): string {
  return `pulsar · plantilla 1

# IA aplicada
horizonte: ${M12}-01
medida: horas de estudio · minutos

## Fases
- ${TODAY} a ${shiftDay(`${M3}-01`, -1)} · Evals y harness

## Meses
- ${M0} · 12 h
- ${M1} · 20 h

## Compromisos
- Tema técnico · martes y jueves · 2 h
- Inglés pasivo · cada día · toque

## Tareas
- ${M0} · 4 h · Leer AI Engineering cap. 1–4
- ${M0} · Tutor
  - 1 h · Elegir tutor
  - 6 h · Sesiones 1–4
`;
}

function draftOf(text: string): Draft {
  const parsed = parseTemplate(text);
  if (!parsed.matched || "error" in parsed) throw new Error(`the template did not parse: ${JSON.stringify(parsed)}`);
  return parsed.draft;
}

// Four goals, each with every section: more of everything than the example.
function fourGoals(rhythmLine = ""): string {
  const goals = [1, 2, 3, 4].map(
    (n) => `
# RP-37 fixture: meta ${n}
horizonte: ${M12}-01
medida: horas de estudio · minutos${rhythmLine}

## Fases
- ${TODAY} a ${shiftDay(`${M3}-01`, -1)} · Primera
- ${M3}-01 a ${shiftDay(`${M6}-01`, -1)} · Segunda

## Meses
- ${M0} · 12 h
- ${M1} · 20 h
- ${M2} · 1,5 h

## Compromisos
- Tema técnico ${n} · martes y jueves · 2 h
- Inglés pasivo ${n} · cada día · toque
- Repaso ${n} · 3 veces por semana · 30 min

## Tareas
- ${M0} · 4 h · Leer ${n}
- ${M0} · 2 h · Escribir ${n}
- ${M1} · Tutor ${n}
  - 1 h · Elegir
  - 6 h · Sesiones
  - 2 h · Cierre
- ${M1} · Otro ${n}
  - 1 h · Uno
`,
  );
  return `pulsar · plantilla 1\n${goals.join("")}`;
}

// The application statements the action put on the wire, settle included:
// begin, commit and a cold connection's type fetch are not statements it chose.
async function counted<T>(run: () => Promise<T>): Promise<{ result: T; statements: number }> {
  wire = [];
  try {
    const result = await run();
    const calls = wire.map((call) => call.query.trim().toLowerCase());
    assert.equal(calls.filter((q) => q === "begin").length, 1, "one begin");
    assert.equal(calls.filter((q) => q === "commit").length, 1, "one commit");
    const statements = calls.filter(
      (q) => q !== "begin" && q !== "commit" && !q.includes("pg_catalog.pg_type"),
    ).length;
    return { result, statements };
  } finally {
    wire = null;
  }
}

async function confirmed(draft: Draft) {
  const { result, statements } = await counted(() => confirmImport(draft));
  if (!result.ok) throw new Error(`confirmImport: ${result.error} at ${result.at}`);
  goalIds.push(...result.goalIds);
  return { goalIds: result.goalIds, statements };
}

// Per run, so a count sees this run's rows only and an orphan of a red run cannot fail the next.
const RUN = Date.now().toString(36);

async function countGoals(name: string): Promise<number> {
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from goals.goals where user_id = ${personId} and name = ${name}`;
  return count;
}

before(async () => {
  installStubs(loadCookies());
  ({ confirmImport } = await import("@/app/actions/import"));
  ({ parseTemplate } = await import("@/lib/import/template"));
  ({ todayInZone } = await import("@/lib/zone"));
  TODAY = todayInZone();
  M0 = TODAY.slice(0, 7);
  [M1, M2, M3, M6, M12, M14] = [1, 2, 3, 6, 12, 14].map((n) => addMonths(M0, n));
  EXAMPLE = exampleText();
  const { getPerson } = await import("@/lib/session");
  const person = await getPerson();
  if (!person) throw new Error("no settled session — mint-session.ts's cookie did not verify");
  personId = person.id;
  const [other] = await sql<{ id: string }[]>`
    select id from auth.users
    where email like 'harness%@example.invalid' and id <> ${personId}
    order by (email = ${`harness-member-${laneNumber()}@example.invalid`}) desc limit 1`;
  if (!other) throw new Error("no second identity in auth.users — run harness:token for this lane");
  otherId = other.id;
});

after(async () => {
  // Cascades to each fixture's phases, budgets, commitments and one-offs.
  if (goalIds.length > 0) await sql`delete from goals.goals where id in ${sql(goalIds)}`;
  await sql.end();
});

const measured: { one?: number; four?: number } = {};

test("confirmImport: the template's example writes its goal and every row reads back", async () => {
  revalidated.length = 0;
  const { goalIds: ids, statements } = await confirmed(draftOf(EXAMPLE));
  measured.one = statements;
  assert.equal(ids.length, 1);
  const [goalId] = ids;
  assert.deepEqual(revalidated, ["/", "/metas"]);

  const [goal] = await sql`
    select user_id, name, horizon::text as horizon, measure_name, measure_unit, archived_at
    from goals.goals where id = ${goalId}`;
  assert.deepEqual({ ...goal }, {
    user_id: personId,
    name: "IA aplicada",
    horizon: `${M12}-01`,
    measure_name: "horas de estudio",
    measure_unit: "minutos",
    archived_at: null,
  });

  const phases = await sql`
    select aim, starts_on::text as s, ends_on::text as e from goals.phases where goal_id = ${goalId}`;
  assert.deepEqual(phases.map((p) => ({ ...p })), [{ aim: "Evals y harness", s: TODAY, e: shiftDay(`${M3}-01`, -1) }]);

  // Minutes (RP-35): 12 h and 20 h.
  const months = await sql`
    select month::text as month, amount from goals.month_budgets where goal_id = ${goalId} order by month`;
  assert.deepEqual(months.map((m) => ({ ...m })), [
    { month: `${M0}-01`, amount: 720 },
    { month: `${M1}-01`, amount: 1200 },
  ]);

  const commitments = await sql`
    select name, cadence_kind, cadence_n, cadence_weekdays, satisfaction, target_quantity, unit, retired_at
    from goals.commitments where goal_id = ${goalId} order by name`;
  assert.deepEqual(commitments.map((c) => ({ ...c, cadence_weekdays: c.cadence_weekdays && [...c.cadence_weekdays] })), [
    { name: "Inglés pasivo", cadence_kind: "daily", cadence_n: null, cadence_weekdays: null, satisfaction: "tap", target_quantity: null, unit: null, retired_at: null },
    { name: "Tema técnico", cadence_kind: "weekdays", cadence_n: null, cadence_weekdays: [2, 4], satisfaction: "quantity", target_quantity: 120, unit: "minutos", retired_at: null },
  ]);

  const tasks = await sql<{ id: string; parent_id: string | null; name: string; estimate: number | null; planned_month: string | null; day: string | null }[]>`
    select id, parent_id, name, estimate, planned_month::text as planned_month, day::text as day
    from goals.one_offs where goal_id = ${goalId} order by name`;
  const tutor = tasks.find((t) => t.name === "Tutor")!;
  assert.deepEqual(
    tasks.map((t) => [t.name, t.parent_id === null ? null : t.parent_id === tutor.id ? "Tutor" : "?", t.estimate, t.planned_month, t.day]),
    [
      ["Elegir tutor", "Tutor", 60, null, null],
      ["Leer AI Engineering cap. 1–4", null, 240, `${M0}-01`, null],
      ["Sesiones 1–4", "Tutor", 360, null, null],
      ["Tutor", null, null, `${M0}-01`, null],
    ],
  );
});

test("confirmImport: a four-goal draft pays the same number of statements as the one-goal example", async () => {
  const draft = draftOf(fourGoals());
  assert.equal(draft.goals.length, 4);
  const { goalIds: ids, statements } = await confirmed(draft);
  measured.four = statements;
  assert.equal(ids.length, 4);
  console.log(`# statements for 1 goal = ${measured.one}, for 4 goals = ${measured.four}`);
  assert.equal(measured.four, measured.one);
  // Settle, goals, measure, phases, budgets, commitments, parents, children.
  assert.equal(measured.one, 8);

  const [{ tasks, children }] = await sql<{ tasks: number; children: number }[]>`
    select count(*) filter (where parent_id is null)::int as tasks,
           count(*) filter (where parent_id is not null)::int as children
    from goals.one_offs where goal_id in ${sql(ids)}`;
  assert.deepEqual({ tasks, children }, { tasks: 16, children: 16 });
});

test("confirmImport: a month outside the goal's span is refused with its key and path, and writes nothing", async () => {
  const draft = draftOf(EXAMPLE.replace("# IA aplicada", `# RP-37 fixture: fuera de plazo ${RUN}`).replace(`- ${M1} · 20 h`, `- ${M14} · 20 h`));
  const result = await confirmImport(draft);
  assert.deepEqual(result, { ok: false, error: "import.errors.monthAfterEnd", at: "goals.0.months.1" });
  assert.equal(await countGoals(`RP-37 fixture: fuera de plazo ${RUN}`), 0);
});

test("confirmImport: a goal whose end already passed is refused whole", async () => {
  const draft = draftOf(EXAMPLE.replace("# IA aplicada", `# RP-37 fixture: pasada ${RUN}`).replace(`${M12}-01`, TODAY));
  const result = await confirmImport(draft);
  assert.deepEqual(result, { ok: false, error: "import.errors.horizonPast", at: "goals.0.horizon" });
  assert.equal(await countGoals(`RP-37 fixture: pasada ${RUN}`), 0);
});

test("confirmImport: a draft with an extra unknown field is refused by the schema", async () => {
  const draft = draftOf(EXAMPLE.replace("# IA aplicada", `# RP-37 fixture: campo extra ${RUN}`));
  const forged = { goals: [{ ...draft.goals[0], admin: true }] };
  const result = await confirmImport(forged);
  assert.deepEqual(result, { ok: false, error: "import.errors.draftInvalid", at: "goals.0" });
  assert.equal(await countGoals(`RP-37 fixture: campo extra ${RUN}`), 0);
  assert.deepEqual(await confirmImport({ goals: [] }), { ok: false, error: "import.errors.empty", at: "goals" });
});

test("confirmImport: a parent task with its own estimate is refused at the parent and writes nothing", async () => {
  const name = `RP-37 fixture: padre con monto ${RUN}`;
  const draft = draftOf(EXAMPLE.replace("# IA aplicada", `# ${name}`));
  draft.goals[0].tasks[1] = { ...draft.goals[0].tasks[1], estimate: 30 };
  assert.deepEqual(await confirmImport(draft), { ok: false, error: "import.errors.parentWithAmount", at: "goals.0.tasks.1" });
  assert.equal(await countGoals(name), 0);
});

test("confirmImport: a forged draft with an estimate on a goal with no measure is refused whole and writes nothing", async () => {
  const name = `RP-37 fixture: estimado sin medida ${RUN}`;
  const draft = draftOf(EXAMPLE.replace("# IA aplicada", `# ${name}`));
  const [first] = draft.goals;
  draft.goals[0] = {
    ...first,
    measure: null,
    months: [],
    commitments: first.commitments.filter((c) => c.satisfaction === "tap"),
  };
  assert.deepEqual(await confirmImport(draft), { ok: false, error: "month.errors.noMeasure", at: "goals.0.tasks.0" });
  assert.equal(await countGoals(name), 0);
});

test("confirmImport: a tap commitment with a target is refused at the commitment and writes nothing", async () => {
  const name = `RP-37 fixture: toque con monto ${RUN}`;
  const draft = draftOf(EXAMPLE.replace("# IA aplicada", `# ${name}`));
  draft.goals[0].commitments[1] = { ...draft.goals[0].commitments[1], targetQuantity: 5, unit: "minutos" };
  assert.deepEqual(await confirmImport(draft), { ok: false, error: "import.errors.tapWithAmount", at: "goals.0.commitments.1" });
  assert.equal(await countGoals(name), 0);
});

test("confirmImport: a commitment the table refuses leaves no goal behind", async () => {
  const name = `RP-37 fixture: atómica ${RUN}`;
  const draft = draftOf(EXAMPLE.replace("# IA aplicada", `# ${name}`));
  // A daily commitment with a count passes the form's schema and meets
  // `commitments_n_for_counted_kinds` at the commitments insert, after the goals.
  draft.goals[0].commitments[1] = { ...draft.goals[0].commitments[1], cadenceN: 3 };
  // The table's own refusal, not any throw: a check violation naming the constraint.
  const { pgCode } = await import("@/lib/db-error");
  await assert.rejects(
    () => confirmImport(draft),
    (error: unknown) => {
      assert.equal(pgCode(error), "23514");
      const cause = (error as { cause?: { constraint_name?: string } }).cause;
      assert.equal(cause?.constraint_name, "commitments_n_for_counted_kinds");
      return true;
    },
  );
  assert.equal(await countGoals(name), 0);
});

test("confirmImport: the second person sees none of the rows", async () => {
  const ids = goalIds.slice();
  assert.ok(ids.length >= 5);
  const claims = JSON.stringify({ sub: otherId, role: "authenticated" });
  const seen = await sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true),
                    set_config('search_path', 'goals, public', true),
                    set_config('role', 'authenticated', true)`;
    const counts: Record<string, number> = {};
    for (const [table, column] of [["goals", "id"], ["phases", "goal_id"], ["month_budgets", "goal_id"], ["commitments", "goal_id"], ["one_offs", "goal_id"]]) {
      const [{ count }] = await tx.unsafe<{ count: number }[]>(
        `select count(*)::int as count from goals.${table} where ${column} = any($1::uuid[])`,
        [`{${ids.join(",")}}`],
      );
      counts[table] = count;
    }
    return counts;
  });
  assert.deepEqual(seen, { goals: 0, phases: 0, month_budgets: 0, commitments: 0, one_offs: 0 });
  // And the owner does: the zeros above are RLS, not an empty write.
  const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from goals.goals where id in ${sql(ids)}`;
  assert.equal(count, ids.length);
});

// RP-63: the template's `ritmo:` arms the goal as `setRhythm`'s first rhythm would.
function lastMonthStart(): string {
  return `${addMonths(M0, -1)}-01`;
}

test("confirmImport: ritmo: 12 h writes goals.rhythm = 720 and plan_seen as setRhythm, and arms the plan", async () => {
  const text = EXAMPLE.replace("# IA aplicada", "# RP-63 fixture: ritmo").replace("medida: horas de estudio · minutos", "medida: horas de estudio · minutos\nritmo: 12 h");
  const draft = draftOf(text);
  assert.equal(draft.goals[0].rhythm, 720);
  const { goalIds: [goalId] } = await confirmed(draft);
  const [row] = await sql`select rhythm, plan_seen::text as plan_seen from goals.goals where id = ${goalId}`;
  assert.deepEqual({ ...row }, { rhythm: 720, plan_seen: lastMonthStart() });
  const { loadGoal } = await import("@/lib/queries/goal");
  const view = await loadGoal(goalId, TODAY);
  assert.ok(view);
  assert.equal(view.roadmap.state, "planned");
  assert.equal(view.planSeen, lastMonthStart());
});

test("confirmImport: without ritmo: the rhythm and plan_seen stay null", async () => {
  const { goalIds: [goalId] } = await confirmed(draftOf(EXAMPLE.replace("# IA aplicada", "# RP-63 fixture: sin ritmo")));
  const [row] = await sql`select rhythm, plan_seen from goals.goals where id = ${goalId}`;
  assert.deepEqual({ ...row }, { rhythm: null, plan_seen: null });
  const { loadGoal } = await import("@/lib/queries/goal");
  assert.equal((await loadGoal(goalId, TODAY))?.roadmap.state, "noRhythm");
});

test("confirmImport: a rhythm on a measure that is not time is refused with its key and writes nothing", async () => {
  const name = `RP-63 fixture: ritmo en km ${RUN}`;
  const draft = draftOf(EXAMPLE.replace("# IA aplicada", `# ${name}`));
  draft.goals[0] = { ...draft.goals[0], rhythm: 720, measure: { name: "distancia", unit: "km" }, commitments: [], tasks: [], months: [] };
  assert.deepEqual(await confirmImport(draft), { ok: false, error: "roadmap.errors.rhythmNotTime", at: "goals.0.rhythm" });
  assert.equal(await countGoals(name), 0);
});

test("confirmImport: four goals with a rhythm pay the statements of one", async () => {
  const draft = draftOf(fourGoals("\nritmo: 12 h"));
  assert.ok(draft.goals.every((goal) => goal.rhythm === 720));
  const { goalIds: ids, statements } = await confirmed(draft);
  assert.equal(ids.length, 4);
  assert.equal(statements, measured.one);
  const [{ armed }] = await sql<{ armed: number }[]>`
    select count(*)::int as armed from goals.goals where id in ${sql(ids)} and rhythm = 720 and plan_seen is not null`;
  assert.equal(armed, 4);
});

// RP-67: with a rhythm the tasks go into the plan and their month only orders them.
function withRhythm(text: string, name: string): string {
  return text
    .replace("# IA aplicada", `# ${name}`)
    .replace("medida: horas de estudio · minutos", "medida: horas de estudio · minutos\nritmo: 12 h");
}

test("confirmImport: the example with a rhythm puts its parents in the plan, with no month", async () => {
  const { goalIds: [goalId] } = await confirmed(draftOf(withRhythm(EXAMPLE, "RP-67 fixture: ritmo en el plan")));
  const parents = await sql`
    select name, planned_month::text as planned_month, in_plan from goals.one_offs
    where goal_id = ${goalId} and parent_id is null order by name`;
  assert.deepEqual(parents.map((p) => ({ ...p })), [
    { name: "Leer AI Engineering cap. 1–4", planned_month: null, in_plan: true },
    { name: "Tutor", planned_month: null, in_plan: true },
  ]);
  const children = await sql`select in_plan from goals.one_offs where goal_id = ${goalId} and parent_id is not null`;
  assert.equal(children.length, 2);
  assert.ok(children.every((c) => c.in_plan));
});

test("confirmImport: with a rhythm a task written for a later month ends after an earlier one in position", async () => {
  const text = withRhythm(EXAMPLE, "RP-67 fixture: orden por mes").replace(
    `## Tareas\n- ${M0} · 4 h · Leer AI Engineering cap. 1–4\n- ${M0} · Tutor`,
    `## Tareas\n- ${M1} · 2 h · Tarde\n- ${M0} · 4 h · Temprano\n- ${M1} · 1 h · Tarde segunda\n- ${M0} · Tutor`,
  );
  const { goalIds: [goalId] } = await confirmed(draftOf(text));
  const rows = await sql<{ name: string }[]>`
    select name from goals.one_offs where goal_id = ${goalId} and parent_id is null order by position`;
  assert.deepEqual(rows.map((r) => r.name), ["Temprano", "Tutor", "Tarde", "Tarde segunda"]);
  const kids = await sql<{ name: string }[]>`
    select c.name from goals.one_offs c join goals.one_offs p on p.id = c.parent_id
    where c.goal_id = ${goalId} order by p.position, c.position`;
  assert.deepEqual(kids.map((k) => k.name), ["Elegir tutor", "Sesiones 1–4"]);
});

test("confirmImport: the plan spreads the imported goal from the current month", async () => {
  const { goalIds: [goalId] } = await confirmed(draftOf(withRhythm(EXAMPLE, "RP-67 fixture: el plan reparte")));
  const { loadGoal } = await import("@/lib/queries/goal");
  const view = await loadGoal(goalId, TODAY);
  assert.ok(view);
  assert.equal(view.roadmap.state, "planned");
  const [first] = view.roadmap.months;
  assert.equal(first.month, `${M0}-01`);
  assert.ok(first.items.length > 0);
});

test("confirmImport: without a rhythm the parents keep the month they were written with", async () => {
  const { goalIds: [goalId] } = await confirmed(draftOf(EXAMPLE.replace("# IA aplicada", "# RP-67 fixture: mes fijo")));
  const parents = await sql`
    select planned_month::text as planned_month, in_plan from goals.one_offs where goal_id = ${goalId} and parent_id is null`;
  assert.ok(parents.length > 0 && parents.every((p) => p.planned_month === `${M0}-01` && p.in_plan));
});

test("confirmImport: a draft measured in hours arrives in minutes", async () => {
  const name = "RP-65 fixture: horas";
  const draft = draftOf(EXAMPLE.replace("# IA aplicada", `# ${name}`));
  const [first] = draft.goals;
  draft.goals[0] = {
    ...first,
    measure: { name: "estudio", unit: "horas" },
    months: [{ month: M0, amount: 12 }],
    commitments: [],
    tasks: [{ name: "Leer", month: M0, estimate: 3, children: [] }],
  };
  const { goalIds: [goalId] } = await confirmed(draft);
  const [goal] = await sql`select measure_unit from goals.goals where id = ${goalId}`;
  assert.equal(goal.measure_unit, "minutos");
  const [month] = await sql`select amount from goals.month_budgets where goal_id = ${goalId}`;
  assert.equal(month.amount, 720);
  const [task] = await sql`select estimate from goals.one_offs where goal_id = ${goalId}`;
  assert.equal(task.estimate, 180);
});

test("confirmImport: a forged figure in a goal not measured in time is refused whole and writes nothing", async () => {
  const name = `RP-66 fixture: cifra en km ${RUN}`;
  const draft = draftOf(EXAMPLE.replace("# IA aplicada", `# ${name}`));
  const [first] = draft.goals;
  draft.goals[0] = {
    ...first,
    measure: { name: "distancia", unit: "km" },
    months: [],
    commitments: [],
    tasks: [{ name: "Correr", month: M0, estimate: 5, children: [] }],
  };
  assert.deepEqual(await confirmImport(draft), { ok: false, error: "import.errors.estimateNotTime", at: "goals.0.tasks.0" });
  assert.equal(await countGoals(name), 0);
});

test("confirmImport: a rhythm does not raise the statements", async () => {
  const { statements } = await confirmed(draftOf(withRhythm(EXAMPLE, "RP-67 fixture: sentencias")));
  assert.equal(statements, measured.one);
});
