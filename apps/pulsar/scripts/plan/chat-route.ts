// Drives `POST /chat/enviar` (`app/(app)/chat/enviar/route.ts`, RP-91-RP-94, RNP-21)
// as the exported function, the way `import-route.ts` drives the import:
// `server-only` and `next/headers` stubbed before the first `@/` import, and the
// cookie `harness:mint-session` left standing is the session `getPerson()` reads.
// The model is never reached: `PULSAR_CHAT_STUB` answers in place of it, and the
// real path goes through a fake `fetch` that records how many `chat` rows the
// person held when it was asked. The pooler seeds the cap's rows and reads every
// table of the `goals` schema that carries a `user_id`, to prove the chat stores
// nothing of the conversation.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { dirname, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";

import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, type Person } from "../mcp/lib/people";

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

// Swapped to [] for the signed-out case.
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
const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 2 });

type Rows = { outcome: string | null; source: string; model: string; input_tokens: number | null; output_tokens: number | null }[];

let route: typeof import("@/app/(app)/chat/enviar/route");
let envHandle: { OPENAI_API_KEY?: string; PULSAR_CHAT_STUB?: string };
let userId: string;
let cookies: StoredCookie[];
let foreign: Person;
const seeded = { goal: "", task: "", foreignTask: "", foreignGoal: "" };

const STUB_FILE = resolve(process.cwd(), `private/chat-route-stub-${laneNumber()}.json`);

const MARKER = `marca-${Date.now()}-conversacion`;

const realFetch = globalThis.fetch;
let fetchCalls: { rowsSeen: number }[] = [];
let modelAnswer: () => Response = () => new Response("unset", { status: 500 });

async function chatRows(): Promise<Rows> {
  return sql<Rows>`
    select outcome, source, model, input_tokens, output_tokens from goals.model_calls
    where user_id = ${userId} and source = 'chat' order by called_at`;
}

function stubScript(script: Record<string, unknown>): void {
  mkdirSync(dirname(STUB_FILE), { recursive: true });
  writeFileSync(STUB_FILE, JSON.stringify(script));
  envHandle.PULSAR_CHAT_STUB = `script:${STUB_FILE}`;
}

function request(body: unknown) {
  return new Request("http://localhost/chat/enviar", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }) as unknown as Parameters<typeof route.POST>[0];
}

const say = (text: string) => ({ turns: [{ role: "person", text }] });

async function seedChat(count: number, source: "chat" | "paste" = "chat") {
  for (let i = 0; i < count; i++) {
    await sql`insert into goals.model_calls (user_id, model, source, outcome) values (${userId}, 'RNP-21 fixture', ${source}, 'ok')`;
  }
}

// Rows of any `goals` table that carry the marker. The lane's person is shared with the other
// plan checks running beside this file, so a count of their rows would race; a marker cannot.
async function carrying(marker: string): Promise<Record<string, number>> {
  const tables = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables where table_schema = 'goals' and table_type = 'BASE TABLE' order by 1`;
  const found: Record<string, number> = {};
  for (const { table_name } of tables) {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from ${sql("goals." + table_name)} as t where t::text like ${"%" + marker + "%"}`;
    if (row.n > 0) found[table_name] = row.n;
  }
  return found;
}

before(async () => {
  cookies = loadCookies();
  installStubs();
  standing = cookies;
  ({ env: envHandle } = (await import("@/lib/env")) as unknown as { env: typeof envHandle });
  route = await import("@/app/(app)/chat/enviar/route");
  const { getPerson } = await import("@/lib/session");
  const person = await getPerson();
  if (!person) throw new Error("the standing session names no person — run harness:mint-session");
  userId = person.id;

  const horizon = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
  const [goal] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit)
    values (${userId}, 'chat-route meta', ${horizon}, 'Medida', 'min') returning id`;
  const [task] = await sql<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, in_plan) values (${userId}, ${goal.id}, 'chat-route Maze', true) returning id`;
  seeded.goal = goal.id;
  seeded.task = task.id;

  const runId = await openCheckRun(admin);
  [foreign] = await createPeople(admin, runId, door, 1);
  const [foreignGoal] = await admin<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit)
    values (${foreign.id}, 'chat-route ajena', ${horizon}, 'Medida', 'min') returning id`;
  const [foreignTask] = await admin<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, in_plan) values (${foreign.id}, ${foreignGoal.id}, 'chat-route secreta', true) returning id`;
  seeded.foreignGoal = foreignGoal.id;
  seeded.foreignTask = foreignTask.id;

  await sql`delete from goals.model_calls where user_id = ${userId} and source = 'chat'`;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).startsWith("https://api.openai.com/")) return realFetch(url as string, init);
    fetchCalls.push({ rowsSeen: (await chatRows()).length });
    return modelAnswer();
  }) as typeof fetch;
});

beforeEach(async () => {
  standing = cookies;
  delete envHandle.OPENAI_API_KEY;
  fetchCalls = [];
  modelAnswer = () => new Response("unset", { status: 500 });
  stubScript({
    "¿Cómo voy?": { reply: "Vas bien." },
    "Fija Maze": {
      reply: "Esto cambiaría tu plan:",
      calls: [{ name: "fix_task", arguments: { one_off_id: seeded.task, month: "2099-01" } }],
    },
    [`Fija Maze ${MARKER}`]: {
      reply: `Esto cambiaría tu plan ${MARKER}`,
      calls: [{ name: "fix_task", arguments: { one_off_id: seeded.task, month: "2099-01" } }],
    },
    "Fija la ajena": {
      reply: "Esto cambiaría tu plan:",
      calls: [{ name: "fix_task", arguments: { one_off_id: seeded.foreignTask, month: "2099-01" } }],
    },
    "Pon 4 h": {
      reply: "Esto cambiaría tu plan:",
      calls: [{ name: "set_month_amount", arguments: { goal_id: seeded.goal, month: "2099-01", amount: 240 } }],
    },
  });
  await sql`delete from goals.model_calls where user_id = ${userId} and source = 'chat'`;
});

after(async () => {
  globalThis.fetch = realFetch;
  delete envHandle.PULSAR_CHAT_STUB;
  try {
    await sql`delete from goals.model_calls where user_id = ${userId}`;
    await sql`delete from goals.one_offs where id = ${seeded.task}`;
    await sql`delete from goals.goals where id = ${seeded.goal}`;
    await admin`delete from goals.one_offs where id = ${seeded.foreignTask}`;
    await admin`delete from goals.goals where id = ${seeded.foreignGoal}`;
    await dropPeople(admin);
  } finally {
    await sql.end();
    await door.end();
    await admin.end();
  }
});

async function body(response: Response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a parsed JSON body
}

test("signed out: 401 chat.errors.signedOut, no row", async () => {
  standing = [];
  const response = await route.POST(request(say("¿Cómo voy?")));
  assert.equal(response.status, 401);
  assert.equal((await body(response)).error, "chat.errors.signedOut");
  assert.equal((await chatRows()).length, 0);
});

test("a blank or malformed body: 422 chat.errors.blank, no row", async () => {
  for (const bad of ["no es json", { turns: [] }, { turns: [{ role: "person", text: "" }] }, { turns: [{ role: "chat", text: "hola", changes: [] }] }]) {
    const response = await route.POST(request(bad));
    assert.equal(response.status, 422);
    assert.equal((await body(response)).error, "chat.errors.blank");
  }
  assert.equal((await chatRows()).length, 0);
});

test("no key, no stub: 503 chat.errors.noKey, no row, no model", async () => {
  delete envHandle.PULSAR_CHAT_STUB;
  const response = await route.POST(request(say("¿Cómo voy?")));
  assert.equal(response.status, 503);
  assert.equal((await body(response)).error, "chat.errors.noKey");
  assert.equal((await chatRows()).length, 0);
  assert.equal(fetchCalls.length, 0);
});

test("the cap: fifty chat rows today refuse with 429, the model is never asked, still fifty rows", async () => {
  delete envHandle.PULSAR_CHAT_STUB;
  envHandle.OPENAI_API_KEY = "sk-never-sent";
  await seedChat(50);
  const response = await route.POST(request(say("¿Cómo voy?")));
  assert.equal(response.status, 429);
  assert.equal((await body(response)).error, "chat.errors.cap");
  assert.equal(fetchCalls.length, 0);
  assert.equal((await chatRows()).length, 50);
});

test("import rows do not cap the chat: ten paste rows still answer 200", async () => {
  await seedChat(10, "paste");
  const response = await route.POST(request(say("¿Cómo voy?")));
  assert.equal(response.status, 200);
  await sql`delete from goals.model_calls where user_id = ${userId} and source = 'paste'`;
});

test("claim then settle: one chat row, the model's name, outcome ok, tokens written", async () => {
  const response = await route.POST(request(say("¿Cómo voy?")));
  assert.equal(response.status, 200);
  const answer = await body(response);
  assert.equal(answer.reply, "Vas bien.");
  assert.deepEqual(answer.changes, []);
  const rows = await chatRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "chat");
  assert.equal(rows[0].model, "gpt-5-mini");
  assert.equal(rows[0].outcome, "ok");
  assert.notEqual(rows[0].input_tokens, null);
  assert.notEqual(rows[0].output_tokens, null);
});

test("the real path: the claim is on the table, unsettled, when the model is asked; it settles with the model's tokens", async () => {
  delete envHandle.PULSAR_CHAT_STUB;
  envHandle.OPENAI_API_KEY = "sk-never-sent";
  modelAnswer = () =>
    Response.json({
      choices: [{ message: { content: "Vas bien." } }],
      usage: { prompt_tokens: 120, completion_tokens: 34 },
    });
  const response = await route.POST(request(say("¿Cómo voy?")));
  assert.equal(response.status, 200);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].rowsSeen, 1);
  const [row] = await chatRows();
  assert.deepEqual([row.outcome, row.input_tokens, row.output_tokens], ["ok", 120, 34]);
});

test("a failure is settled: stub fail answers 502 chat.errors.failed and the row reads failed", async () => {
  envHandle.PULSAR_CHAT_STUB = "fail";
  const response = await route.POST(request(say("¿Cómo voy?")));
  assert.equal(response.status, 502);
  assert.equal((await body(response)).error, "chat.errors.failed");
  const rows = await chatRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "failed");
});

test("a change comes back in the person's words: the key and the task's own name", async () => {
  const response = await route.POST(request(say("Fija Maze")));
  assert.equal(response.status, 200);
  const { changes } = await body(response);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].tool, "fix_task");
  assert.equal(changes[0].words.key, "chat.change.fix_task");
  assert.equal(changes[0].words.values.task, "chat-route Maze");
  assert.equal(changes[0].refused, undefined);
  assert.equal(typeof changes[0].id, "string");
});

test("a month amount on a month with none reads «sin monto → 4 h»", async () => {
  const { changes } = await body(await route.POST(request(say("Pon 4 h"))));
  assert.equal(changes[0].words.values.before, "sin monto");
  assert.equal(changes[0].words.values.after, "4 h");
});

test("an id of another person is refused, its name never read", async () => {
  const response = await route.POST(request(say("Fija la ajena")));
  assert.equal(response.status, 200);
  const text = JSON.stringify(await body(response));
  const { changes } = JSON.parse(text);
  assert.equal(changes[0].refused, "chat.errors.notInPlan");
  assert.equal(changes[0].words, undefined);
  assert.equal(text.includes("chat-route secreta"), false);
});

test("nothing of the conversation is stored: no row of any goals table carries the message or the reply", async () => {
  const response = await route.POST(request(say(`Fija Maze ${MARKER}`)));
  assert.equal(response.status, 200);
  assert.ok(JSON.stringify(await body(response)).includes(MARKER), "the reply carries the marker the tables must not");
  assert.deepEqual(await carrying(MARKER), {});
  assert.deepEqual(await carrying("Fija Maze"), {});
  const [row] = await sql<Record<string, unknown>[]>`select * from goals.model_calls where user_id = ${userId} and source = 'chat'`;
  assert.deepEqual(Object.keys(row).filter((key) => /text|message|content|prompt|reply/i.test(key)), []);
});

test("an id the model made up, no uuid, refuses its own change and costs the others nothing", async () => {
  stubScript({
    "Fija dos": {
      reply: "Esto cambiaría tu plan:",
      calls: [
        { name: "fix_task", arguments: { one_off_id: "la tarea de Maze", month: "2099-01" } },
        { name: "fix_task", arguments: { one_off_id: seeded.task, month: "2099-01" } },
        { name: "set_month_amount", arguments: { goal_id: "1; drop table goals.goals", month: "2099-01", amount: 60 } },
      ],
    },
  });
  const response = await route.POST(request(say("Fija dos")));
  assert.equal(response.status, 200);
  const { changes } = await body(response);
  assert.equal(changes.length, 3);
  assert.equal(changes[0].refused, "chat.errors.notInPlan");
  assert.equal(changes[1].refused, undefined);
  assert.equal(changes[1].words.values.task, "chat-route Maze");
  assert.equal(changes[2].refused, "chat.errors.notInPlan");
  assert.equal((await chatRows())[0].outcome, "ok");
});
