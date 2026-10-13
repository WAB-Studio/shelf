// Drives `makeChatChange` (`app/actions/chat.ts`, RP-92) the way `task-actions.ts`
// drives an action: the action imported as a plain async function, `server-only`,
// `next/headers` and `next/cache` stubbed before the first `@/` import, and the
// cookie `harness:mint-session` left standing as the session. «Hacer» opens no
// write path: each test compares the action's answer with what the catalogue
// (what `/mcp` answers through) gives for the same call.
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

let standing: StoredCookie[] = [];

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
    if (request === "next/cache") return { revalidatePath() {} };
    return originalLoad(request, parent, isMain);
  };
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });

let makeChatChange: typeof import("@/app/actions/chat").makeChatChange;
let writeTool: typeof import("@/lib/tools/catalogue").writeTool;
let errorOf: typeof import("@/lib/mcp/errors").errorOf;
let todayInZone: typeof import("@/lib/zone").todayInZone;
let cookies: StoredCookie[];
let userId: string;
const seeded = { goal: "", fixTask: "", noteTask: "", archiveGoal: "" };

function monthFrom(delta: number): string {
  const today = todayInZone();
  const index = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

before(async () => {
  cookies = loadCookies();
  installStubs();
  standing = cookies;
  ({ makeChatChange } = await import("@/app/actions/chat"));
  ({ writeTool } = await import("@/lib/tools/catalogue"));
  ({ errorOf } = await import("@/lib/mcp/errors"));
  ({ todayInZone } = await import("@/lib/zone"));
  const { getPerson } = await import("@/lib/session");
  const person = await getPerson();
  if (!person) throw new Error("the standing session names no person — run harness:mint-session");
  userId = person.id;

  const horizon = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
  const goal = async (name: string) =>
    (
      await sql<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, measure_name, measure_unit)
        values (${userId}, ${name}, ${horizon}, 'Medida', 'min') returning id`
    )[0].id;
  const task = async (goalId: string, name: string, note: string | null) =>
    (
      await sql<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, in_plan, note)
        values (${userId}, ${goalId}, ${name}, true, ${note}) returning id`
    )[0].id;
  seeded.goal = await goal("chat-actions meta");
  seeded.archiveGoal = await goal("chat-actions no archivar");
  seeded.fixTask = await task(seeded.goal, "chat-actions fijar", null);
  seeded.noteTask = await task(seeded.goal, "chat-actions nota", "nota de siempre");
});

after(async () => {
  try {
    await sql`delete from goals.one_offs where id in ${sql([seeded.fixTask, seeded.noteTask])}`;
    await sql`delete from goals.goals where id in ${sql([seeded.goal, seeded.archiveGoal])}`;
  } finally {
    await sql.end();
  }
});

const plannedMonth = async (id: string) =>
  (await sql<{ m: string | null }[]>`select to_char(planned_month, 'YYYY-MM') as m from goals.one_offs where id = ${id}`)[0].m;

test("signed out: chat.errors.signedOut and nothing runs", async () => {
  standing = [];
  const out = await makeChatChange({ tool: "fix_task", input: { one_off_id: seeded.fixTask, month: monthFrom(1) } });
  standing = cookies;
  assert.deepEqual(out, { ok: false, ...errorOf("chat.errors.signedOut") });
  assert.equal(await plannedMonth(seeded.fixTask), null);
});

test("«Hacer» makes it: fix_task fixes the task's month through the catalogue's act", async () => {
  const month = monthFrom(1);
  const out = await makeChatChange({ tool: "fix_task", input: { one_off_id: seeded.fixTask, month } });
  assert.deepEqual(out, { ok: true });
  assert.equal(await plannedMonth(seeded.fixTask), month);
  await makeChatChange({ tool: "unfix_task", input: { one_off_id: seeded.fixTask } });
  assert.equal(await plannedMonth(seeded.fixTask), null);
});

test("a past month is refused with the key and sentence /mcp answers for fix_task", async () => {
  const input = { one_off_id: seeded.fixTask, month: monthFrom(-1) };
  const direct = await writeTool("fix_task")!.run(input);
  assert.equal(direct.ok, false);
  if (direct.ok) return;
  const mcp = errorOf(direct.error, direct.values);
  assert.equal(mcp.key, "roadmap.errors.monthOutsideSpan");

  const out = await makeChatChange({ tool: "fix_task", input });
  assert.deepEqual(out, { ok: false, ...mcp });
  assert.equal(await plannedMonth(seeded.fixTask), null);
});

test("a tool outside the write catalogue is chat.errors.notAllowed and the goal stays open", async () => {
  for (const tool of ["archive_goal", "delete_one_off", "get_goal", "nope"]) {
    const out = await makeChatChange({ tool, input: { goal_id: seeded.archiveGoal } });
    assert.deepEqual(out, { ok: false, ...errorOf("chat.errors.notAllowed") }, tool);
  }
  const [row] = await sql`select archived_at from goals.goals where id = ${seeded.archiveGoal}`;
  assert.equal(row.archived_at, null);
});

test("a malformed call is notAllowed, never a throw", async () => {
  for (const bad of [null, "fix_task", { tool: 3 }, { tool: "fix_task" }, { tool: "fix_task", input: { month: 7 } }]) {
    assert.deepEqual(await makeChatChange(bad), { ok: false, ...errorOf("chat.errors.notAllowed") }, JSON.stringify(bad));
  }
});

test("a blank task note is refused as /mcp refuses it and the note stays", async () => {
  const out = await makeChatChange({ tool: "set_task_note", input: { one_off_id: seeded.noteTask, note: "  " } });
  assert.deepEqual(out, { ok: false, ...errorOf("mcp.errors.noteEmpty") });
  const [row] = await sql`select note from goals.one_offs where id = ${seeded.noteTask}`;
  assert.equal(row.note, "nota de siempre");
});
