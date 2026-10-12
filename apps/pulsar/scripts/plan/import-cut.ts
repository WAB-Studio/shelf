// Drives `confirmImport` (`app/actions/import.ts`, RP-37) with phases that
// start or end before the day the goal opens: the cut is stored, not only
// listed. Same stubs and session as `import-actions.ts`.
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
let parseTemplate: typeof import("@/lib/import/template").parseTemplateV1;
type Draft = import("@/lib/import/draft").ImportDraftV1;

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, {
  prepare: false,
  max: 1,
  connection: { statement_timeout: 15_000, lock_timeout: 10_000 },
});

const goalIds: string[] = [];

function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(date);
}

let TODAY: string;
let HORIZON: string;

// One goal whose `## Fases` lines are given; nothing else varies.
function goalText(name: string, phaseLines: string[]): string {
  return `pulsar · plantilla 1

# ${name}
horizonte: ${HORIZON}
medida: horas de estudio · minutos

## Fases
${phaseLines.join("\n")}

## Meses
- ${TODAY.slice(0, 7)} · 12 h

## Compromisos
- Tema técnico · martes y jueves · 2 h

## Tareas
- ${TODAY.slice(0, 7)} · 4 h · Leer
`;
}

function draftOf(text: string): Draft {
  const parsed = parseTemplate(text);
  if (!parsed.matched || "error" in parsed) throw new Error(`the template did not parse: ${JSON.stringify(parsed)}`);
  return parsed.draft;
}

// The application statements the action put on the wire, begin and commit aside.
async function confirmed(draft: Draft): Promise<{ goalId: string; statements: number }> {
  wire = [];
  try {
    const result = await confirmImport(draft);
    if (!result.ok) throw new Error(`confirmImport: ${result.error} at ${result.at}`);
    goalIds.push(...result.goalIds);
    const statements = wire
      .map((call) => call.query.trim().toLowerCase())
      .filter((q) => q !== "begin" && q !== "commit" && !q.includes("pg_catalog.pg_type")).length;
    return { goalId: result.goalIds[0], statements };
  } finally {
    wire = null;
  }
}

async function phasesOf(goalId: string) {
  return sql<{ aim: string; starts_on: string; ends_on: string }[]>`
    select aim, starts_on::text as starts_on, ends_on::text as ends_on
    from goals.phases where goal_id = ${goalId} order by starts_on`;
}

before(async () => {
  installStubs(loadCookies());
  ({ confirmImport } = await import("@/app/actions/import"));
  ({ parseTemplateV1: parseTemplate } = await import("@/lib/import/template"));
  ({ todayInZone } = await import("@/lib/zone"));
  TODAY = todayInZone();
  HORIZON = `${shiftDay(TODAY, 400).slice(0, 7)}-01`;
  const { getPerson } = await import("@/lib/session");
  if (!(await getPerson())) throw new Error("no settled session — mint-session.ts's cookie did not verify");
});

after(async () => {
  if (goalIds.length > 0) await sql`delete from goals.goals where id in ${sql(goalIds)}`;
  await sql.end();
});

test("confirmImport: a phase that starts before the goal opens is stored starting today", async () => {
  const early = shiftDay(TODAY, -5);
  const end = shiftDay(TODAY, 60);
  const { goalId } = await confirmed(draftOf(goalText("RP-37 cut: empieza antes", [`- ${early} a ${end} · Evals`])));
  assert.deepEqual((await phasesOf(goalId)).map((p) => ({ ...p })), [{ aim: "Evals", starts_on: TODAY, ends_on: end }]);
});

test("confirmImport: a phase wholly before the goal opens is not stored, its neighbour is", async () => {
  const end = shiftDay(TODAY, 60);
  const { goalId } = await confirmed(
    draftOf(
      goalText("RP-37 cut: termina antes", [
        `- ${shiftDay(TODAY, -40)} a ${shiftDay(TODAY, -10)} · Pasada`,
        `- ${shiftDay(TODAY, 1)} a ${end} · Viva`,
      ]),
    ),
  );
  assert.deepEqual((await phasesOf(goalId)).map((p) => ({ ...p })), [{ aim: "Viva", starts_on: shiftDay(TODAY, 1), ends_on: end }]);
});

test("confirmImport: a draft with no early phase stores as written and the cut adds no statement", async () => {
  const start = shiftDay(TODAY, 3);
  const end = shiftDay(TODAY, 60);
  const plain = await confirmed(draftOf(goalText("RP-37 cut: sin recorte", [`- ${start} a ${end} · Viva`])));
  assert.deepEqual((await phasesOf(plain.goalId)).map((p) => ({ ...p })), [{ aim: "Viva", starts_on: start, ends_on: end }]);
  const cut = await confirmed(draftOf(goalText("RP-37 cut: mismo conteo", [`- ${shiftDay(TODAY, -5)} a ${end} · Viva`])));
  assert.equal(cut.statements, plain.statements);
});

test("confirmImport: phases wholly before the goal opens that overlap each other are cut away before the overlap is judged", async () => {
  const end = shiftDay(TODAY, 60);
  const draft = draftOf(goalText("RP-37 cut: pasadas que se cruzan", [`- ${shiftDay(TODAY, 1)} a ${end} · Viva`]));
  const [live] = draft.goals[0].phases;
  draft.goals[0].phases = [
    { aim: "Pasada A", startsOn: shiftDay(TODAY, -40), endsOn: shiftDay(TODAY, -10) },
    { aim: "Pasada B", startsOn: shiftDay(TODAY, -30), endsOn: shiftDay(TODAY, -5) },
    live,
  ];
  const { goalId } = await confirmed(draft);
  assert.deepEqual((await phasesOf(goalId)).map((p) => ({ ...p })), [{ aim: "Viva", starts_on: shiftDay(TODAY, 1), ends_on: end }]);
});
