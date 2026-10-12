// Drives `confirmImport` (`app/actions/import.ts`, RP-47) for the order it
// writes: goals, a goal's commitments and its tasks (children under their
// parent) take positions in the draft's order, after every row the person
// already has, and the confirm pays the statements it paid before. Stubs and
// session as in `import-actions.ts`; rows are read back through the pooler,
// ordered by `position` alone.
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
let parseTemplate: typeof import("@/lib/import/template").parseTemplate;
type Draft = import("@/lib/import/draft").ImportDraft;

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, {
  prepare: false,
  max: 1,
  connection: { statement_timeout: 15_000, lock_timeout: 10_000 },
});

const goalIds: string[] = [];
let personId: string;

const NAMES = ["Zorro", "Mango", "Alfa", "Tigre", "Bravo", "Kilo"];

function planText(prefix: string): string {
  const goal = (name: string) => `
# ${prefix} ${name}
horizonte: 2099-12-01
medida: horas de estudio · minutos

## Compromisos
${NAMES.map((n) => `- ${n} ${name} · cada día · toque`).join("\n")}

## Tareas
${NAMES.map((n, i) => `- 2099-06 · ${n} ${name}${i % 2 === 0 ? `\n  - 1 h · Hijo b ${n}\n  - 1 h · Hijo a ${n}` : ""}`).join("\n")}
`;
  return `pulsar · plantilla 1\n${goal("Zeta")}${goal("Alfa")}`;
}

function draftOf(text: string): Draft {
  const parsed = parseTemplate(text);
  if (!parsed.matched || "error" in parsed) throw new Error(`the template did not parse: ${JSON.stringify(parsed)}`);
  return parsed.draft;
}

async function counted<T>(run: () => Promise<T>): Promise<{ result: T; statements: number }> {
  wire = [];
  try {
    const result = await run();
    const calls = wire.map((call) => call.query.trim().toLowerCase());
    const statements = calls.filter(
      (q) => q !== "begin" && q !== "commit" && !q.includes("pg_catalog.pg_type"),
    ).length;
    return { result, statements };
  } finally {
    wire = null;
  }
}

const seeded: string[] = [];
let seedMax: number;
let seedCommitmentMax: number;
let seedTaskMax: number;
let imported: { ids: string[]; statements: number };

before(async () => {
  installStubs(loadCookies());
  ({ confirmImport } = await import("@/app/actions/import"));
  ({ parseTemplate: parseTemplate } = await import("@/lib/import/template"));
  const { getPerson } = await import("@/lib/session");
  const person = await getPerson();
  if (!person) throw new Error("no settled session — mint-session.ts's cookie did not verify");
  personId = person.id;
  // Three goals the person already has, made the way a hand does: the trigger names their position.
  for (const n of [1, 2, 3]) {
    const [row] = await sql<{ id: string; position: number }[]>`
      insert into goals.goals (user_id, name, horizon) values (${personId}, ${`RP-47 fixture: previa ${n}`}, '2099-12-01')
      returning id, position`;
    seeded.push(row.id);
    seedMax = row.position;
  }
  // One commitment and one task the person already has, on the first seeded goal.
  [{ position: seedCommitmentMax }] = await sql<{ position: number }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
    values (${personId}, ${seeded[0]}, 'RP-47 fixture: compromiso previo', 'daily', 'tap')
    returning position`;
  [{ position: seedTaskMax }] = await sql<{ position: number }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${personId}, ${seeded[0]}, 'RP-47 fixture: tarea previa', '2099-06-01')
    returning position`;
  const draft = draftOf(planText("RP-47 fixture:"));
  const { result, statements } = await counted(() => confirmImport(draft));
  if (!result.ok) throw new Error(`confirmImport: ${result.error} at ${result.at}`);
  goalIds.push(...result.goalIds);
  imported = { ids: result.goalIds, statements };
});

after(async () => {
  const all = [...goalIds, ...seeded];
  if (all.length > 0) await sql`delete from goals.goals where id in ${sql(all)}`;
  await sql.end();
});

test("import order: goals read back in the template's order, after the three the person had", async () => {
  const rows = await sql<{ name: string; position: number }[]>`
    select name, position from goals.goals where id in ${sql(imported.ids)} order by position`;
  assert.deepEqual(rows.map((r) => r.name), ["RP-47 fixture: Zeta", "RP-47 fixture: Alfa"]);
  assert.ok(rows[0].position > seedMax, `${rows[0].position} must come after the person's own ${seedMax}`);
  assert.equal(rows[1].position - rows[0].position, 1);
});

test("import order: commitments keep the template's order across the draft, not the names' or the ids'", async () => {
  const rows = await sql<{ name: string; position: number }[]>`
    select name, position from goals.commitments where goal_id in ${sql(imported.ids)} order by position`;
  const expected = ["Zeta", "Alfa"].flatMap((g) => NAMES.map((n) => `${n} ${g}`));
  assert.deepEqual(rows.map((r) => r.name), expected);
  assert.ok(rows[0].position > seedCommitmentMax, `${rows[0].position} must come after the person's own ${seedCommitmentMax}`);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].position - rows[i - 1].position, 1);
});

test("import order: tasks number across the draft and each child sits right after its parent, in its own order", async () => {
  const rows = await sql<{ name: string; position: number; parent_id: string | null }[]>`
    select name, position, parent_id from goals.one_offs where goal_id in ${sql(imported.ids)} order by position`;
  const expected = ["Zeta", "Alfa"].flatMap((g) =>
    NAMES.flatMap((n, i) => [`${n} ${g}`, ...(i % 2 === 0 ? [`Hijo b ${n}`, `Hijo a ${n}`] : [])]),
  );
  assert.deepEqual(rows.map((r) => r.name), expected);
  assert.ok(rows[0].position > seedTaskMax, `${rows[0].position} must come after the person's own ${seedTaskMax}`);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].position - rows[i - 1].position, 1);
});

test("import order: the confirm pays the statements it paid before position was written", () => {
  // Settle, goals, measure, commitments, parents, children: phases and budgets are absent.
  assert.equal(imported.statements, 6);
});
