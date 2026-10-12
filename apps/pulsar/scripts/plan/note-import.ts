// Drives `confirmImport` (`app/actions/import.ts`, RP-45) with a template that
// carries `nota:` lines: the action imported as a plain async function,
// `server-only`, `next/headers` and `next/cache` stubbed before the first `@/`
// import, and the cookie `harness:mint-session` left standing as the session.
// "Today" is pinned to 2026-09-30 so the example's months are in the future.
// Rows are read back through the pooler.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

import postgres from "postgres";

const TODAY = "2026-09-30";

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
    if (request === "@/lib/zone") {
      const real = originalLoad(request, parent, isMain) as Record<string, unknown>;
      return { ...real, todayInZone: () => TODAY };
    }
    return originalLoad(request, parent, isMain);
  };
}

let confirmImport: typeof import("@/app/actions/import").confirmImport;
let parseTemplate: typeof import("@/lib/import/template").parseTemplate;

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, {
  prepare: false,
  max: 1,
  connection: { statement_timeout: 15_000, lock_timeout: 10_000 },
});

const goalIds: string[] = [];

// `docs/pulsar/PLANTILLA.md`'s example, read from the file.
const DOC = readFileSync(resolve(process.cwd(), "../../docs/pulsar/PLANTILLA.md"), "utf8");
const EXAMPLE = /```\n([\s\S]*?)\n```/.exec(DOC)![1];

// The example is a tree of three goals; a fixture renames all three, references included.
function renamed(suffix: string): string {
  return EXAMPLE.replace(/Carrera en IA|IA aplicada/g, (name) => `${name} ${suffix}`).replace(/# Evals y harness/, `# Evals y harness ${suffix}`).replace(/dentro de: Evals y harness/g, `dentro de: Evals y harness ${suffix}`);
}

function draftOf(text: string) {
  const parsed = parseTemplate(text);
  if (!parsed.matched || "error" in parsed) throw new Error(`the template did not parse: ${JSON.stringify(parsed)}`);
  return parsed.draft;
}

before(async () => {
  installStubs(loadCookies());
  ({ confirmImport } = await import("@/app/actions/import"));
  ({ parseTemplate: parseTemplate } = await import("@/lib/import/template"));
  const { getPerson } = await import("@/lib/session");
  if (!(await getPerson())) throw new Error("no settled session — mint-session.ts's cookie did not verify");
});

after(async () => {
  // Cascades to each fixture's one-offs.
  if (goalIds.length > 0) await sql`delete from goals.goals where id in ${sql(goalIds)}`;
  await sql.end();
});

test("confirmImport: the example's notes land on the goals, the task and the sub-task; the rest stay empty", async () => {
  const draft = draftOf(renamed("RP-45 fixture: notas"));
  const result = await confirmImport(draft);
  assert.ok(result.ok, JSON.stringify(result));
  goalIds.push(...result.goalIds);
  const goalNotes = await sql<{ note: string | null }[]>`select note from goals.goals where id in ${sql(result.goalIds)} order by position`;
  assert.deepEqual(goalNotes.map((g) => g.note), [
    "Lo que busco en dos años.\nUn ritmo que pueda sostener.",
    null,
    "Empezar por lo que ya sé medir.",
  ]);
  const rows = await sql<{ name: string; note: string | null }[]>`
    select name, note from goals.one_offs where goal_id = ${result.goalIds[2]} order by name`;
  assert.deepEqual(rows.map((r) => [r.name, r.note]), [
    ["Elegir tutor", "Comparar tres perfiles."],
    ["Leer AI Engineering cap. 1–4", null],
    ["Sesiones 1–4", null],
    ["Tutor", "Preguntar por la tarifa por hora.\nPedir una clase de prueba antes de pagar."],
  ]);
});

test("confirmImport: a forged draft with a note over 2000 characters is refused with the note's key and writes nothing", async () => {
  const name = "Evals y harness RP-45 fixture: nota larga";
  const draft = draftOf(renamed("RP-45 fixture: nota larga"));
  draft.goals[2].tasks[1].children[0].note = "x".repeat(2001);
  assert.deepEqual(await confirmImport(draft), {
    ok: false,
    error: "day.errors.oneOffNoteTooLong",
    at: "goals.2.tasks.1.children.0.note",
  });
  const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from goals.goals where name = ${name}`;
  assert.equal(count, 0);
});
