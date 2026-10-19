// The chat route's size and turn limits (RP-91, 1.10.3), driven as the exported function the way
// `chat-route.ts` does. The model is a fake `fetch` that records what it was sent; nothing is paid.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";

import postgres from "postgres";

function laneNumber(): number {
  const raw = process.env.HARNESS_LANE?.trim();
  if (!raw) return 1;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`HARNESS_LANE must be a positive integer, not "${raw}"`);
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
  if (state.cookies.length === 0) throw new Error(`${file} carries no cookie`);
  return state.cookies.map(({ name, value }) => ({ name, value }));
}

let standing: StoredCookie[] = [];

function installStubs(): void {
  const untyped = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "server-only") return {};
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => standing, set() {} }) };
    if (request === "next/cache") return { revalidatePath() {} };
    return originalLoad(request, parent, isMain);
  };
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });

let route: typeof import("@/app/(app)/chat/enviar/route");
let envHandle: { OPENAI_API_KEY?: string; PULSAR_CHAT_STUB?: string };
let userId: string;
const realFetch = globalThis.fetch;
let modelSaw: { messages: { role: string; content: string }[] }[] = [];

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/chat/enviar", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  }) as unknown as Parameters<typeof route.POST>[0];
}

const chatRows = async () =>
  (await sql<{ n: number }[]>`select count(*)::int as n from goals.model_calls where user_id = ${userId} and source = 'chat'`)[0].n;

before(async () => {
  standing = loadCookies();
  installStubs();
  ({ env: envHandle } = (await import("@/lib/env")) as unknown as { env: typeof envHandle });
  route = await import("@/app/(app)/chat/enviar/route");
  const { getPerson } = await import("@/lib/session");
  const person = await getPerson();
  if (!person) throw new Error("the standing session names no person — run harness:mint-session");
  userId = person.id;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).startsWith("https://api.openai.com/")) return realFetch(url as string, init);
    modelSaw.push(JSON.parse(String(init!.body)));
    return Response.json({ choices: [{ message: { content: "Vas bien." } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }) as typeof fetch;
});

beforeEach(async () => {
  modelSaw = [];
  delete envHandle.PULSAR_CHAT_STUB;
  envHandle.OPENAI_API_KEY = "sk-never-sent";
  await sql`delete from goals.model_calls where user_id = ${userId} and source = 'chat'`;
});

after(async () => {
  globalThis.fetch = realFetch;
  delete envHandle.OPENAI_API_KEY;
  try {
    await sql`delete from goals.model_calls where user_id = ${userId} and source = 'chat'`;
  } finally {
    await sql.end();
  }
});

const turns = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    i % 2 === count % 2 ? { role: "chat", text: `t${i}`, changes: [] } : { role: "person", text: `t${i}` },
  );

test("41 turns are refused 422 chat.errors.blank before a claim; 40 are answered", async () => {
  const over = await route.POST(request({ turns: turns(41) }));
  assert.equal(over.status, 422);
  assert.equal(((await over.json()) as { error: string }).error, "chat.errors.blank");
  assert.equal(await chatRows(), 0);
  assert.equal(modelSaw.length, 0);
  const at = await route.POST(request({ turns: turns(40) }));
  assert.equal(at.status, 200);
});

test("a body of 1 MiB + 1 byte is refused 422 before a claim; exactly 1 MiB is read", async () => {
  const say = { turns: [{ role: "person", text: "¿Cómo voy?" }] };
  const over = await route.POST(request(say, { "content-length": String(1024 * 1024 + 1) }));
  assert.equal(over.status, 422);
  assert.equal(await chatRows(), 0);
  assert.equal(modelSaw.length, 0);
  const at = await route.POST(request(say, { "content-length": String(1024 * 1024) }));
  assert.equal(at.status, 200);
});

test("the 21st turn back never reaches the model: 25 turns send the system prompt and the last 20", async () => {
  const response = await route.POST(request({ turns: turns(25) }));
  assert.equal(response.status, 200);
  assert.equal(modelSaw.length, 1);
  const sentTurns = modelSaw[0].messages.filter((message) => message.role !== "system");
  assert.equal(sentTurns.length, 20);
  assert.equal(sentTurns[0].content, "t5");
  assert.equal(sentTurns[19].content, "t24");
});
