// Drives `POST /importar/leer` (`app/importar/leer/route.ts`, RP-37, RNP-13)
// as the exported function, the way `task-actions.ts` drives an action:
// `server-only`, `next/headers` stubbed before the first `@/` import, and the
// cookie `harness:mint-session` left standing is the session `getPerson()`
// reads. The model is never reached: the stub seam (`PULSAR_MODEL_STUB`) answers
// in place of it, and one test sends the real path through a fake `fetch` that
// streams, recording how many `model_calls` rows the person held when it was
// asked. The pooler seeds the cap's rows and deletes every call the file made.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { dirname, resolve } from "node:path";
import { after, before, beforeEach, mock, test } from "node:test";

import ExcelJS from "exceljs";
import { createTranslator } from "next-intl";
import postgres from "postgres";

const importMessages = JSON.parse(readFileSync(resolve(process.cwd(), "messages/es/import.json"), "utf8"));
const say = (key: string) =>
  (createTranslator({ locale: "es", messages: { import: importMessages }, namespace: "import" }) as unknown as (k: string) => string)(key);

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
    return originalLoad(request, parent, isMain);
  };
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });

type Rows = { outcome: string | null; source: string; input_tokens: number | null }[];

let route: typeof import("@/app/importar/leer/route");
let envHandle: { OPENAI_API_KEY?: string; PULSAR_MODEL_STUB?: string };
let userId: string;
let cookies: StoredCookie[];


// What the stub hands back in place of the model: the reader's raw draft, before `normalize`.
const STUB_FILE = resolve(process.cwd(), `private/import-route-stub-${laneNumber()}.json`);

function rawGoal(over: Record<string, unknown> = {}) {
  return {
    key: "g1",
    parent: null,
    name: "IA aplicada",
    horizon: "2027-10-01",
    measure: { name: "horas de estudio", unit: "minutos" },
    rate: null,
    noteSrc: [],
    noteText: null,
    src: [{ from: 1, to: 1 }],
    phases: [],
    months: [{ month: "2026-10", amount: 720, src: [{ from: 2, to: 2 }] }],
    commitments: [],
    rules: [],
    tasks: [],
    ...over,
  };
}

function stubDraft(...goals: Record<string, unknown>[]): void {
  mkdirSync(dirname(STUB_FILE), { recursive: true });
  writeFileSync(STUB_FILE, JSON.stringify({ goals }));
  envHandle.PULSAR_MODEL_STUB = `draft:${STUB_FILE}`;
}

const catalogue = JSON.parse(readFileSync(resolve(process.cwd(), "messages/es/import.json"), "utf8"));
// Plantilla 2, the catalogue's own example: three levels of goals with notes.
const TEMPLATE: string = catalogue.template.example;
const TEMPLATE_V1 =
  "pulsar · plantilla 1\n\n# IA aplicada\nhorizonte: 2027-10-01\nmedida: horas de estudio · minutos\n\n## Meses\n- 2026-10 · 12 h";

const realFetch = globalThis.fetch;
// What each fake model call saw: the person's rows at the moment it was asked.
let modelCalls: { rowsSeen: Rows }[] = [];
let modelAnswer: (init?: RequestInit) => Response = () => new Response("unset", { status: 500 });

// A streamed completion, the way chat completions sends it: pieces of the answer, then usage.
function sse(content: string): Response {
  const cut = content.indexOf('"goals"') + 3;
  const events = [
    { choices: [{ delta: { content: content.slice(0, cut) } }] },
    { choices: [{ delta: { content: content.slice(cut) }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 120, completion_tokens: 340 } },
  ];
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function rows(): Promise<Rows> {
  return sql<Rows>`
    select outcome, source, input_tokens from goals.model_calls
    where user_id = ${userId} order by called_at`;
}

function request(parts: Record<string, string | File>, headers: Record<string, string> = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(parts)) form.set(key, value);
  return new Request("http://localhost/importar/leer", { method: "POST", body: form, headers }) as unknown as Parameters<
    typeof route.POST
  >[0];
}

before(async () => {
  cookies = loadCookies();
  installStubs();
  standing = cookies;
  ({ env: envHandle } = (await import("@/lib/env")) as unknown as { env: typeof envHandle });
  route = await import("@/app/importar/leer/route");
  const { getPerson } = await import("@/lib/session");
  const person = await getPerson();
  if (!person) throw new Error("the standing session names no person — run harness:mint-session");
  userId = person.id;
  await sql`delete from goals.model_calls where user_id = ${userId}`;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).startsWith("https://api.openai.com/")) return realFetch(url as string, init);
    modelCalls.push({ rowsSeen: await rows() });
    return modelAnswer(init);
  }) as typeof fetch;
});

beforeEach(async () => {
  standing = cookies;
  envHandle.OPENAI_API_KEY = "sk-never-sent";
  stubDraft(rawGoal());
  modelCalls = [];
  modelAnswer = () => new Response("unset", { status: 500 });
  await sql`delete from goals.model_calls where user_id = ${userId}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  delete envHandle.PULSAR_MODEL_STUB;
  await sql`delete from goals.model_calls where user_id = ${userId}`;
  await sql.end();
});

async function seedToday(count: number) {
  for (let i = 0; i < count; i++) {
    await sql`insert into goals.model_calls (user_id, model, source, outcome) values (${userId}, 'RNP-13 fixture', 'paste', 'ok')`;
  }
}

// RP-126: the app's day. The cap is set to what the table holds today plus `room`, so rows other lanes left
// do not move the test. These files run one at a time (`scripts/harness/plan-run.ts`).
async function withAppCap<T>(room: number, run: () => Promise<T>): Promise<T> {
  const [{ count }] = await sql<{ count: string }[]>`
    select count(*) from goals.model_calls where day = (now() at time zone 'America/Bogota')::date`;
  const before = process.env.APP_MODEL_CALLS_DAILY_CAP;
  process.env.APP_MODEL_CALLS_DAILY_CAP = String(Number(count) + room);
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.APP_MODEL_CALLS_DAILY_CAP;
    else process.env.APP_MODEL_CALLS_DAILY_CAP = before;
  }
}

async function answer(response: Response) {
  assert.notEqual(response.status, 204, "never a 204");
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()) as Record<string, unknown>;
}

type Line = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a parsed JSON line

// The model path answers 200 application/x-ndjson: one JSON object a line.
async function ndjson(response: Response): Promise<Line[]> {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/x-ndjson/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text();
  assert.ok(text.endsWith("\n"), "every line ends with a newline");
  return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

const lastLine = (lines: Line[]) => lines[lines.length - 1];

test("signed out: 401 import.errors.signedOut, no claim", async () => {
  standing = [];
  const response = await route.POST(request({ text: "algo" }));
  assert.equal(response.status, 401);
  assert.equal((await answer(response)).error, "import.errors.signedOut");
  assert.equal((await rows()).length, 0);
});

test("a file over 4 MB: 413 import.errors.tooBig, and so is a declared body over it", async () => {
  const big = new File([new Uint8Array(4 * 1024 * 1024 + 1)], "plan.txt", { type: "text/plain" });
  const response = await route.POST(request({ file: big }));
  assert.equal(response.status, 413);
  assert.equal((await answer(response)).error, "import.errors.tooBig");

  const declared = await route.POST(request({ text: "algo" }, { "content-length": String(5 * 1024 * 1024) }));
  assert.equal(declared.status, 413);
  assert.equal(modelCalls.length, 0);
  assert.equal((await rows()).length, 0);
});

test("a template text (plantilla 2): 200 via template with its draft, corrections, notices and source; no key, no row, no model", async () => {
  delete envHandle.OPENAI_API_KEY;
  delete envHandle.PULSAR_MODEL_STUB;
  const response = await route.POST(request({ text: TEMPLATE }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  const body = await answer(response);
  assert.equal(body.via, "template");
  const draft = body.draft as { version: number; goals: { name: string; parent: string | null; note: string | null }[] };
  assert.equal(draft.version, 2);
  assert.deepEqual(draft.goals.map((g) => g.name), ["Carrera en IA", "IA aplicada", "Evals y harness", "Leer"]);
  assert.equal(draft.goals[0].note, "Lo que busco en dos años.\nUn ritmo que pueda sostener.");
  assert.ok(Array.isArray(body.corrections));
  assert.ok(Array.isArray(body.notices));
  const source = body.source as { kind: string; lines: string[] };
  assert.equal(source.kind, "lines");
  assert.equal(source.lines.length, TEMPLATE.split("\n").length);
  assert.equal((await rows()).length, 0);
  assert.equal(modelCalls.length, 0);
});

test("a template looked at before the claim: with the cap spent it still reads, and no row is added", async () => {
  await seedToday(10);
  const response = await route.POST(request({ text: TEMPLATE }));
  assert.equal(response.status, 200);
  assert.equal((await answer(response)).via, "template");
  assert.equal((await rows()).length, 10);
});

test("a template file is read as UTF-8 the same way", async () => {
  delete envHandle.OPENAI_API_KEY;
  const file = new File([TEMPLATE_V1], "plan.md", { type: "text/markdown" });
  const response = await route.POST(request({ file }));
  assert.equal(response.status, 200);
  assert.equal((await answer(response)).via, "template");
  assert.equal((await rows()).length, 0);
});

test("a template with a broken line: 422 templateLine with its line and form, no row, no model", async () => {
  const broken = TEMPLATE_V1.replace("- 2026-10 · 12 h", "- octubre · 12 h");
  const response = await route.POST(request({ text: broken }));
  assert.equal(response.status, 422);
  const body = await answer(response);
  assert.equal(body.error, "import.errors.templateLine");
  const errors = body.errors as { line: number; expected: string }[];
  assert.equal(errors.length, 1);
  const first = errors[0];
  assert.equal(first.line, broken.split("\n").indexOf("- octubre · 12 h") + 1);
  // `expected` is a key into the catalogue; the sentence it names is what the person reads, and never the line they wrote.
  let sentence: unknown = catalogue;
  for (const part of String(first.expected).replace(/^import\./, "").split(".")) {
    sentence = (sentence as Record<string, unknown> | undefined)?.[part];
  }
  assert.equal(typeof sentence, "string", `«${first.expected}» is not in messages/es/import.json`);
  assert.equal((sentence as string).includes("- octubre · 12 h"), false);
  assert.equal((await rows()).length, 0);
  assert.equal(modelCalls.length, 0);
});

test("a broken template with no key is still 422, never 503", async () => {
  delete envHandle.OPENAI_API_KEY;
  delete envHandle.PULSAR_MODEL_STUB;
  const response = await route.POST(request({ text: TEMPLATE_V1.replace("- 2026-10 · 12 h", "- octubre · 12 h") }));
  assert.equal(response.status, 422);
});

test("no key: 503 import.errors.noKey, no row, no model", async () => {
  delete envHandle.OPENAI_API_KEY;
  delete envHandle.PULSAR_MODEL_STUB;
  const response = await route.POST(request({ text: "quiero aprender inglés este año" }));
  assert.equal(response.status, 503);
  assert.equal((await answer(response)).error, "import.errors.noKey");
  assert.equal((await rows()).length, 0);
  assert.equal(modelCalls.length, 0);
});

test("a blank text: 422 import.errors.blank, no row", async () => {
  const response = await route.POST(request({ text: "   " }));
  assert.equal(response.status, 422);
  assert.equal((await answer(response)).error, "import.errors.blank");
  assert.equal((await rows()).length, 0);
});

test("the model path: the steps come in order — find, arrange, check, done — and done is the last line", async () => {
  const lines = await ndjson(await route.POST(request({ text: "quiero aprender inglés este año" })));
  assert.deepEqual(lines.slice(0, 3), [{ step: "find" }, { step: "arrange" }, { step: "check" }]);
  assert.equal(lines.length, 4);
  const done = lastLine(lines).done;
  assert.equal(done.via, "model");
  assert.equal(done.draft.version, 2);
  assert.equal(done.draft.goals[0].name, "IA aplicada");
  assert.deepEqual(done.draft.goals[0].months.map((m: { amount: number }) => m.amount), [720]);
  assert.ok(Array.isArray(done.corrections));
  assert.ok(Array.isArray(done.notices));
  // The source goes back with its lines: the client counts the rest from it.
  assert.deepEqual(done.source, { kind: "lines", lines: ["quiero aprender inglés este año"] });
});

test("the server fixes the draft: a name of 150 arrives as 120, with the correction that says so", async () => {
  stubDraft(rawGoal({ name: "x".repeat(150) }));
  const lines = await ndjson(await route.POST(request({ text: "un plan cualquiera" })));
  const done = lastLine(lines).done;
  assert.equal(done.draft.goals[0].name.length, 120);
  assert.ok((done.corrections as { code: string }[]).some((c) => c.code === "nameShortened"));
});

test("the real path streams: the claim is on the table before the model is asked, unsettled; done comes with it settled", async () => {
  delete envHandle.PULSAR_MODEL_STUB;
  modelAnswer = () => sse(JSON.stringify({ context: "x", goals: [rawGoal()] }));
  const response = await route.POST(request({ text: "quiero aprender inglés este año" }));
  const lines = await ndjson(response);
  assert.deepEqual(lines.slice(0, 3), [{ step: "find" }, { step: "arrange" }, { step: "check" }]);
  assert.equal(lastLine(lines).done.via, "model");

  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].rowsSeen.length, 1, "claimed before the model ran");
  assert.equal(modelCalls[0].rowsSeen[0].outcome, null, "unsettled while the model ran");
  const after = await rows();
  assert.equal(after.length, 1);
  assert.equal(after[0].outcome, "ok");
  assert.equal(after[0].source, "paste");
  assert.equal(after[0].input_tokens, 120);
});

test("the charge is settled before the last line: reading done, the row already carries its outcome", async () => {
  const response = await route.POST(request({ text: "quiero aprender inglés este año" }));
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  let atDone: Rows | null = null;
  let atFirst: Rows | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
    if (atFirst === null && seen.includes('"find"')) atFirst = await rows();
    if (seen.includes('"done"')) {
      atDone = await rows();
      break;
    }
  }
  assert.ok(atFirst && atFirst.length === 1, "the row exists when the first line arrives");
  assert.ok(atDone && atDone.length === 1 && atDone[0].outcome === "ok", "settled when done arrives");
  await reader.cancel();
});

test("a non-template file goes to the model as a file claim", async () => {
  const file = new File(["quiero aprender inglés"], "plan.txt", { type: "text/plain" });
  const lines = await ndjson(await route.POST(request({ file })));
  assert.equal(lastLine(lines).done.via, "model");
  assert.equal((await rows())[0].source, "file");
});

// One empty page: the header, the three objects the reader's page count looks for, a trailer.
const ONE_PAGE_PDF = [
  "%PDF-1.4",
  "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
  "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
  "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj",
  "trailer << /Root 1 0 R >>",
  "%%EOF",
].join("\n");

test("a four-byte file named plan.pdf is not a PDF: 415, no claim", async () => {
  const file = new File([new Uint8Array([37, 80, 68, 70])], "plan.pdf", { type: "application/pdf" });
  const response = await route.POST(request({ file }));
  assert.equal(response.status, 415);
  assert.equal((await answer(response)).error, "import.errors.unreadableType");
  assert.equal((await rows()).length, 0);
});

test("a PDF goes as parts: the source comes back with no lines to copy", async () => {
  stubDraft(rawGoal({ src: [] }));
  const file = new File([ONE_PAGE_PDF], "plan.pdf", { type: "application/pdf" });
  const lines = await ndjson(await route.POST(request({ file })));
  assert.deepEqual(lastLine(lines).done.source, { kind: "parts", lines: null });
});

test("at ten rows today the eleventh answers 429 import.errors.cap and the model is not called", async () => {
  await seedToday(10);
  const response = await route.POST(request({ text: "quiero aprender inglés este año" }));
  assert.equal(response.status, 429);
  assert.equal((await answer(response)).error, "import.errors.cap");
  assert.equal(modelCalls.length, 0);
  assert.equal((await rows()).length, 10);
});

test("a template still reads at ten rows: no cap on it", async () => {
  await seedToday(10);
  const response = await route.POST(request({ text: TEMPLATE_V1 }));
  assert.equal(response.status, 200);
});

test("the model answers no goals: the last line is import.errors.empty, settled empty", async () => {
  envHandle.PULSAR_MODEL_STUB = "empty";
  const lines = await ndjson(await route.POST(request({ text: "nada que leer aquí" })));
  assert.deepEqual(lastLine(lines), { error: "import.errors.empty" });
  assert.equal((await rows())[0].outcome, "empty");
});

test("the model answers a shape the schema refuses: the last line is import.errors.modelInvalid, settled invalid", async () => {
  envHandle.PULSAR_MODEL_STUB = "invalid";
  const lines = await ndjson(await route.POST(request({ text: "un plan cualquiera" })));
  assert.deepEqual(lastLine(lines), { error: "import.errors.modelInvalid" });
  assert.equal((await rows())[0].outcome, "invalid");
});

test("the model fails: the stream ends on import.errors.modelFailed, never closed without a line, settled failed", async () => {
  envHandle.PULSAR_MODEL_STUB = "fail";
  const lines = await ndjson(await route.POST(request({ text: "un plan cualquiera" })));
  assert.deepEqual(lastLine(lines), { error: "import.errors.modelFailed" });
  assert.ok(lines.every((line) => !("done" in line)));
  assert.equal((await rows())[0].outcome, "failed");
});

test("the real path fails: a 500 from the model ends the stream on modelFailed", async () => {
  delete envHandle.PULSAR_MODEL_STUB;
  modelAnswer = () => new Response("boom", { status: 500 });
  const lines = await ndjson(await route.POST(request({ text: "un plan cualquiera" })));
  assert.deepEqual(lastLine(lines), { error: "import.errors.modelFailed" });
  assert.equal((await rows())[0].outcome, "failed");
});

test("a file type the reader refuses: 415 import.errors.unreadableType", async () => {
  const file = new File([new Uint8Array([80, 75, 3, 4])], "plan.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const response = await route.POST(request({ file }));
  assert.equal(response.status, 415);
  assert.equal((await answer(response)).error, "import.errors.unreadableType");
  assert.equal(modelCalls.length, 0);
  assert.equal((await rows()).length, 0, "a refused type spends no claim");
});

test("a refused file type answers 415 even with no key: the type is judged before the key", async () => {
  delete envHandle.OPENAI_API_KEY;
  delete envHandle.PULSAR_MODEL_STUB;
  const file = new File([new Uint8Array([80, 75, 3, 4])], "plan.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const response = await route.POST(request({ file }));
  assert.equal(response.status, 415);
  assert.equal((await answer(response)).error, "import.errors.unreadableType");
  assert.equal((await rows()).length, 0);
});

test("a body that is no form: 422 import.errors.blank, no row, no model", async () => {
  const response = await route.POST(
    new Request("http://localhost/importar/leer", {
      method: "POST",
      body: "not a form",
      headers: { "content-type": "multipart/form-data; boundary=x" },
    }) as unknown as Parameters<typeof route.POST>[0],
  );
  assert.equal(response.status, 422);
  assert.equal((await answer(response)).error, "import.errors.blank");
  assert.equal((await rows()).length, 0);
  assert.equal(modelCalls.length, 0);
});

// Module 801.
test("801: a first line «pulsar · plantilla 3» is 422 on line 1, never sent to the model, with no key too", async () => {
  for (const keyed of [true, false]) {
    if (!keyed) delete envHandle.OPENAI_API_KEY;
    const response = await route.POST(request({ text: TEMPLATE_V1.replace("plantilla 1", "plantilla 3") }));
    assert.equal(response.status, 422, `key ${keyed}`);
    const body = await answer(response);
    assert.equal(body.error, "import.errors.templateLine");
    assert.deepEqual((body.errors as { line: number }[]).map((e) => e.line), [1]);
  }
  assert.equal(modelCalls.length, 0);
  assert.equal((await rows()).length, 0);
});

test("801: the same refusal reaches a file, the way a pasted text does", async () => {
  const file = new File([TEMPLATE_V1.replace("plantilla 1", "plantilla 3")], "plan.md", { type: "text/markdown" });
  const response = await route.POST(request({ file }));
  assert.equal(response.status, 422);
  assert.equal(modelCalls.length, 0);
});

test("801: a text that does not start with «pulsar ·» still goes to the model", async () => {
  const lines = await ndjson(await route.POST(request({ text: "plantilla 2\nquiero aprender inglés" })));
  assert.equal(lastLine(lines).done.via, "model");
});

test("801: a broken header answers one error and judges nothing below it", async () => {
  const text = TEMPLATE_V1.replace("medida: horas de estudio · minutos", "medida: horas de estudio").replace("- 2026-10 · 12 h", "- octubre · 12 h");
  const response = await route.POST(request({ text }));
  assert.equal(response.status, 422);
  const errors = (await answer(response)).errors as { line: number; expected: string }[];
  assert.deepEqual(errors, [{ line: 5, expected: "import.errors.form.measure" }]);
  assert.equal(modelCalls.length, 0);
});

// Module 885: the workbook is read by code, never by the model.
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const xlsx = (bytes: Uint8Array, name = "plantilla-goallog.xlsx") => new File([bytes as BlobPart], name, { type: XLSX });

test("the delivered workbook, uploaded: 200 via workbook with its draft; no key, no row, no model", async () => {
  delete envHandle.OPENAI_API_KEY;
  delete envHandle.PULSAR_MODEL_STUB;
  const { templateWorkbook } = await import("@/lib/import/workbook");
  const response = await route.POST(request({ file: xlsx(await templateWorkbook(say)) }));
  assert.equal(response.status, 200);
  const body = await answer(response);
  assert.equal(body.via, "workbook");
  const draft = body.draft as { version: number; goals: { name: string; parent: string | null }[] };
  assert.equal(draft.version, 2);
  assert.deepEqual(draft.goals.map((g) => g.name), ["Carrera en IA", "IA aplicada", "Evals y harness", "Leer"]);
  assert.deepEqual(body.source, { kind: "rows", lines: null });
  assert.ok(Array.isArray(body.corrections) && Array.isArray(body.notices));
  assert.equal((await rows()).length, 0);
  assert.equal(modelCalls.length, 0);
});

test("a workbook with a broken row: 422 workbookRows names its sheet and row; no row, no model", async () => {
  const { templateWorkbook } = await import("@/lib/import/workbook");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await templateWorkbook(say)) as never);
  wb.getWorksheet("Meses")!.getCell("B2").value = "octubre";
  const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
  const response = await route.POST(request({ file: xlsx(bytes) }));
  assert.equal(response.status, 422);
  const body = await answer(response);
  assert.equal(body.error, "import.errors.workbookRows");
  const broken = body.rows as { sheet: string; row: number; expected: string }[];
  assert.deepEqual(broken.map((r) => [r.sheet, r.row]), [["Meses", 2]]);
  assert.equal(typeof broken[0].expected, "string");
  assert.equal((await rows()).length, 0);
  assert.equal(modelCalls.length, 0);
});

test("a workbook that is not the template: 415 workbookNotTemplate, never the model, no row", async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Hoja1").addRow(["quiero aprender inglés"]);
  const response = await route.POST(request({ file: xlsx(new Uint8Array(await wb.xlsx.writeBuffer()), "mis-metas.xlsx") }));
  assert.equal(response.status, 415);
  assert.equal((await answer(response)).error, "import.errors.workbookNotTemplate");
  assert.equal((await rows()).length, 0);
  assert.equal(modelCalls.length, 0);
});

test("a file called .xlsx that is no workbook is not the template either", async () => {
  const response = await route.POST(request({ file: xlsx(new TextEncoder().encode("hola"), "plan.xlsx") }));
  assert.equal(response.status, 415);
  assert.equal((await answer(response)).error, "import.errors.workbookNotTemplate");
  assert.equal((await rows()).length, 0);
});

test("a workbook with the cap spent still reads: no claim for it", async () => {
  await seedToday(10);
  const { templateWorkbook } = await import("@/lib/import/workbook");
  const response = await route.POST(request({ file: xlsx(await templateWorkbook(say)) }));
  assert.equal(response.status, 200);
  assert.equal((await rows()).length, 10);
});

test("the download: GET /importar/plantilla.xlsx hands the workbook as an attachment, signed out, with no row", async () => {
  standing = [];
  const download = await import("@/app/importar/plantilla.xlsx/route");
  const response = await download.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-disposition"), "attachment; filename=plantilla-goallog.xlsx");
  assert.equal(response.headers.get("content-type"), XLSX);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const { readWorkbook } = await import("@/lib/import/workbook");
  const read = await readWorkbook(bytes);
  assert.ok(read.matched && "draft" in read, "the bytes are a workbook the reader takes");
  assert.equal(read.draft.goals.length, 4);
  assert.equal((await rows()).length, 0);
});

// ---- 903

test("903: what the model leaves out reaches the general goal's note on the way to the review", async () => {
  stubDraft(rawGoal({ src: [{ from: 1, to: 1 }], months: [{ month: "2026-10", amount: 720, src: [{ from: 2, to: 2 }] }] }));
  const lines = await ndjson(await route.POST(request({ text: "# Plan\nmes\nRiesgos del plan\n\n  - sin tiempo" })));
  const done = lastLine(lines).done;
  assert.equal(done.draft.goals[0].note, "Riesgos del plan\nsin tiempo");
  assert.deepEqual(done.draft.goals[0].noteSrc, [{ from: 3, to: 3 }, { from: 5, to: 5 }]);
});

test("903: the check's proposal and notice reach the review of a model read", async () => {
  stubDraft(
    rawGoal({
      months: [{ month: "2026-10", amount: 720, src: [{ from: 2, to: 2 }] }],
      rules: [{ id: "r1", label: "Inglés", perWeek: 180 }],
      tasks: [{ name: "Leer", month: "2026-10", estimate: 600, week: "2026-W41", rule: null, noteSrc: [], noteText: null, src: [{ from: 3, to: 3 }], children: [] }],
    }),
  );
  const done = lastLine(await ndjson(await route.POST(request({ text: "uno\ndos\ntres" })))).done;
  assert.deepEqual(done.corrections.map((c: { code: string }) => c.code), ["monthSumDiffers"]);
  assert.deepEqual(done.notices.map((n: { code: string }) => n.code), ["weekRuleBroken"]);
});

test("903: the route may run longer than the read waits", async () => {
  const { REQUEST_TIMEOUT_MS } = await import("@/lib/import/model");
  assert.ok(route.maxDuration * 1000 > REQUEST_TIMEOUT_MS);
  assert.equal(route.maxDuration, 300);
});

test("906: a HECHO line the model left out becomes a done task on its day and leaves the note", async () => {
  stubDraft(rawGoal({ src: [{ from: 1, to: 1 }], months: [] }));
  const text = ["# Plan", "# Reglas", "- [ ] **1 h · EF SET (línea base).** ✅ HECHO el 9 oct 2026", "Sin empleo antes de abril."].join("\n");
  const done = lastLine(await ndjson(await route.POST(request({ text })))).done;
  const [goal] = done.draft.goals;
  assert.equal(goal.note, "Reglas\nSin empleo antes de abril.");
  assert.deepEqual(
    goal.tasks.map((t: { name: string; estimate: number; doneOn: string }) => [t.name, t.estimate, t.doneOn.slice(5)]),
    [["EF SET · línea base", 60, "10-09"]],
  );
  assert.deepEqual(done.corrections, []);
});

// ---- 903c: a second, short pass sends the tasks of a general goal to the goals below it.

const task903c = (name: string, estimate: number, line: number) => ({
  name,
  month: "2026-10",
  estimate,
  week: null,
  rule: null,
  noteSrc: [],
  noteText: null,
  src: [{ from: line, to: line }],
  children: [],
});

function holderDraft() {
  return [
    rawGoal({ key: "g", name: "Carrera", months: [], tasks: [task903c("Wireframes del caso", 120, 2), task903c("Anki diario", 60, 3)] }),
    rawGoal({ key: "c1", parent: "g", name: "Caso #1", src: [{ from: 4, to: 4 }], months: [{ month: "2026-10", amount: 600, src: [{ from: 5, to: 5 }] }] }),
  ];
}

const PLAN_TEXT = "# Carrera\nwireframes\nanki\n# Caso 1\nmes";

// The first call streams the read, the second answers the pass: what the fake model says to each.
function twoCalls(second: () => Response) {
  let n = 0;
  modelAnswer = () => (++n === 1 ? sse(JSON.stringify({ context: [], goals: holderDraft() })) : second());
}

const completion = (content: unknown, usage = { prompt_tokens: 900, completion_tokens: 120 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage }), {
    headers: { "content-type": "application/json" },
  });

test("903c: the pass proposes a move as a correction, the draft stays as read, and the check sees the move", async () => {
  delete envHandle.PULSAR_MODEL_STUB;
  twoCalls(() => completion({ moves: [{ holder: "g", task: 0, to: "c1" }] }));
  const lines = await ndjson(await route.POST(request({ text: PLAN_TEXT })));
  assert.deepEqual(lines.slice(0, 3), [{ step: "find" }, { step: "arrange" }, { step: "check" }]);
  const done = lastLine(lines).done;
  assert.deepEqual(done.draft.goals[0].tasks.map((t: { name: string }) => t.name), ["Wireframes del caso", "Anki diario"]);
  const moved = done.corrections.filter((c: { code: string }) => c.code === "taskMoved");
  assert.deepEqual(moved.map((c: { id: string; said: string; proposed: string }) => [c.id, c.said, c.proposed]), [["goals.0.tasks.0:taskMoved", "Carrera", "Caso #1"]]);
  // «Caso #1» says 10 h a month and now holds a 2 h task: the check, run after the move, says so.
  const sums = done.corrections.filter((c: { code: string }) => c.code === "monthSumDiffers");
  assert.deepEqual(sums.map((c: { at: string; proposed: string }) => [c.at, c.proposed]), [["goals.1.months.0", "120"]]);
});

test("903c: the pass is claimed and settled like the read, as a row of its own", async () => {
  delete envHandle.PULSAR_MODEL_STUB;
  twoCalls(() => completion({ moves: [] }));
  await ndjson(await route.POST(request({ text: PLAN_TEXT })));
  assert.equal(modelCalls.length, 2);
  assert.equal(modelCalls[1].rowsSeen.length, 2, "claimed before the pass was asked");
  assert.equal(modelCalls[1].rowsSeen[1].outcome, null, "unsettled while it ran");
  const after = await sql<{ model: string; source: string; outcome: string | null; input_tokens: number | null; output_tokens: number | null }[]>`
    select model, source, outcome, input_tokens, output_tokens from goals.model_calls where user_id = ${userId} order by called_at`;
  assert.deepEqual(after.map((r) => [r.model, r.source, r.outcome, r.input_tokens, r.output_tokens]), [
    ["gpt-5.5", "paste", "ok", 120, 340],
    ["gpt-5.5/arrange", "paste", "ok", 900, 120],
  ]);
});

test("903c: the pass does not count against the daily reads: nine reads before, and the tenth still reads and arranges", async () => {
  delete envHandle.PULSAR_MODEL_STUB;
  await seedToday(9);
  twoCalls(() => completion({ moves: [] }));
  const lines = await ndjson(await route.POST(request({ text: PLAN_TEXT })));
  assert.ok(lastLine(lines).done);
  assert.equal(modelCalls.length, 2);
  twoCalls(() => completion({ moves: [] }));
  const eleventh = await route.POST(request({ text: PLAN_TEXT }));
  assert.equal(eleventh.status, 429, "ten reads spent the cap, whatever the passes were");
});

test("903c: a pass that fails leaves the draft as read, with no move, and says nothing to the person", async () => {
  delete envHandle.PULSAR_MODEL_STUB;
  twoCalls(() => new Response("{}", { status: 500 }));
  const done = lastLine(await ndjson(await route.POST(request({ text: PLAN_TEXT })))).done;
  assert.deepEqual(done.corrections.filter((c: { code: string }) => c.code === "taskMoved"), []);
  const after = await rows();
  assert.deepEqual(after.map((r) => r.outcome), ["ok", "failed"]);
});

test("903c: a pass that answers a shape the schema refuses is settled invalid", async () => {
  delete envHandle.PULSAR_MODEL_STUB;
  twoCalls(() => completion({ moves: "todas" }));
  const done = lastLine(await ndjson(await route.POST(request({ text: PLAN_TEXT })))).done;
  assert.deepEqual(done.corrections.filter((c: { code: string }) => c.code === "taskMoved"), []);
  assert.deepEqual((await rows()).map((r) => r.outcome), ["ok", "invalid"]);
});

test("903c: a plan with no goal that holds goals and tasks costs no second call", async () => {
  delete envHandle.PULSAR_MODEL_STUB;
  modelAnswer = () => sse(JSON.stringify({ context: "x", goals: [rawGoal()] }));
  await ndjson(await route.POST(request({ text: "quiero aprender inglés este año" })));
  assert.equal(modelCalls.length, 1);
  assert.equal((await rows()).length, 1);
});

test("903c: with the seam standing in for the model there is no second call and no second row", async () => {
  stubDraft(...holderDraft());
  await ndjson(await route.POST(request({ text: PLAN_TEXT })));
  assert.equal(modelCalls.length, 0);
  assert.equal((await rows()).length, 1);
});

test("903c: a box line the model left out is a task in the draft, with its correction", async () => {
  stubDraft(rawGoal({ src: [{ from: 1, to: 1 }], months: [] }));
  const done = lastLine(await ndjson(await route.POST(request({ text: "# Plan\n- [ ] Llamar al banco\n30 min Leer\nRegla sin forma" })))).done;
  const [goal] = done.draft.goals;
  assert.deepEqual(goal.tasks.map((t: { name: string; estimate: number | null }) => [t.name, t.estimate]), [["Llamar al banco", null], ["Leer", 30]]);
  assert.equal(goal.note, "Regla sin forma");
  assert.deepEqual(done.corrections.filter((c: { code: string }) => c.code === "lineToTask").map((c: { at: string }) => c.at), ["goals.0.tasks.0", "goals.0.tasks.1"]);
});

test("RP-126: the app's day spent, a person far under their ten is refused 429 import.errors.capApp, never .cap, the model not called", async () => {
  await seedToday(2);
  await withAppCap(0, async () => {
    const response = await route.POST(request({ text: "quiero aprender inglés este año" }));
    assert.equal(response.status, 429);
    assert.equal((await answer(response)).error, "import.errors.capApp");
  });
  assert.equal(modelCalls.length, 0);
  assert.equal((await rows()).length, 2, "a refused claim leaves no row");
});

test("RP-126: one call of room left in the app's day: that read lands, the next one is refused as the app's", async () => {
  await withAppCap(1, async () => {
    modelAnswer = () => sse(JSON.stringify({ goals: [rawGoal()] }));
    const first = await route.POST(request({ text: "quiero aprender inglés este año" }));
    assert.equal(first.status, 200);
    await first.text();
    const second = await route.POST(request({ text: "quiero aprender inglés este año" }));
    assert.equal(second.status, 429);
    assert.equal((await answer(second)).error, "import.errors.capApp");
  });
  assert.equal((await rows()).length, 1);
});

test("RP-126: the person's own ten spent while the app has room still says .cap, not the app's", async () => {
  await seedToday(10);
  await withAppCap(1000, async () => {
    const response = await route.POST(request({ text: "quiero aprender inglés este año" }));
    assert.equal(response.status, 429);
    assert.equal((await answer(response)).error, "import.errors.cap");
  });
});

test("RP-126: with the app's day spent a template text still reads, via template, and adds no row", async () => {
  await withAppCap(0, async () => {
    const response = await route.POST(request({ text: TEMPLATE }));
    assert.equal(response.status, 200);
    assert.equal((await answer(response)).via, "template");
  });
  assert.equal((await rows()).length, 0);
});

// M18: the guard runs before the session, the body and the claim.
test("M18: a foreign Origin with a pasted plan is refused 403, no claim, no model", async () => {
  const response = await route.POST(request({ text: "quiero aprender inglés este año" }, { origin: "https://evil.example" }));
  assert.equal(response.status, 403);
  assert.equal((await rows()).length, 0);
  assert.equal(modelCalls.length, 0);
});

test("M18: a foreign Origin with a file is refused 403 as well, no claim", async () => {
  const file = new File(["quiero aprender inglés este año"], "plan.txt", { type: "text/plain" });
  const response = await route.POST(request({ file }, { origin: "https://evil.example" }));
  assert.equal(response.status, 403);
  assert.equal((await rows()).length, 0);
  assert.equal(modelCalls.length, 0);
});

test("M18: a foreign Origin with a template is refused too: the template path is behind the guard", async () => {
  const response = await route.POST(request({ text: TEMPLATE }, { origin: "https://evil.example" }));
  assert.equal(response.status, 403);
});

test("M18: a JSON body on the import is refused 415, no claim", async () => {
  const raw = new Request("http://localhost/importar/leer", {
    method: "POST",
    body: JSON.stringify({ text: "quiero aprender inglés este año" }),
    headers: { "content-type": "application/json" },
  }) as unknown as Parameters<typeof route.POST>[0];
  const response = await route.POST(raw);
  assert.equal(response.status, 415);
  assert.equal((await rows()).length, 0);
  assert.equal(modelCalls.length, 0);
});

test("M18: a urlencoded body on the import is refused 415", async () => {
  const raw = new Request("http://localhost/importar/leer", {
    method: "POST",
    body: new URLSearchParams({ text: "quiero aprender inglés este año" }),
  }) as unknown as Parameters<typeof route.POST>[0];
  const response = await route.POST(raw);
  assert.equal(response.status, 415);
  assert.equal((await rows()).length, 0);
});

test("M18: the guard answers before the session: foreign Origin with no session is 403, not 401", async () => {
  standing = [];
  const response = await route.POST(request({ text: "algo" }, { origin: "https://evil.example" }));
  assert.equal(response.status, 403);
});

test("M18: the app's own Origin passes: the model path streams and one row is claimed", async () => {
  const lines = await ndjson(await route.POST(request({ text: "quiero aprender inglés este año" }, { origin: "http://localhost" })));
  assert.ok(lastLine(lines).done);
  assert.equal((await rows()).length, 1);
});

// ---- M27: what a long plan's review and the arrange pass owe the person

// A streamed completion that ends on `finish`, the way a cut read does.
function sseEnding(content: string, finish: string): Response {
  const events = [
    { choices: [{ delta: { content } }] },
    { choices: [{ delta: {}, finish_reason: finish }] },
    { choices: [], usage: { prompt_tokens: 50, completion_tokens: 60 } },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

const userText = (init?: RequestInit): string => JSON.parse(String(init?.body)).messages[1].content[0].text;

test("M27: a long plan whose answer is cut and one section cut again reaches the review naming the section left out", async () => {
  delete envHandle.PULSAR_MODEL_STUB;
  const block = (title: string) => [`# ${title}`, ...Array.from({ length: 199 }, (_, i) => `- paso ${title} ${i}`)];
  const text = [...block("Primero"), ...block("Segundo"), ...block("Tercero")].join("\n");
  modelAnswer = (init) => {
    const numbered = userText(init).split("\n");
    if (numbered.length >= 600) return sseEnding('{"goals":[{"key":"cut', "length");
    const first = Number(numbered[0].split("|")[0]);
    const heading = numbered[0].slice(numbered[0].indexOf("|") + 1).replace(/^#\s+/, "");
    if (heading === "Segundo") return sseEnding('{"goals":[{"key":"cut', "length");
    return sseEnding(JSON.stringify({ goals: [rawGoal({ key: "g", name: heading, months: [], src: [{ from: first, to: first }] })] }), "stop");
  };
  const done = lastLine(await ndjson(await route.POST(request({ text })))).done;
  assert.deepEqual(done.draft.goals.map((g: { name: string }) => g.name), ["Primero", "Tercero"]);
  assert.deepEqual(done.leftOut, [{ heading: "Segundo", from: 201, to: 400 }]);
});

test("M27: a read that left nothing out carries no leftOut to the review", async () => {
  delete envHandle.PULSAR_MODEL_STUB;
  modelAnswer = () => sse(JSON.stringify({ goals: [rawGoal()] }));
  const done = lastLine(await ndjson(await route.POST(request({ text: "quiero aprender inglés este año" })))).done;
  assert.equal("leftOut" in done, false);
});

test("M27: a read that used up the function's time leaves the arrange pass no time: it asks the model nothing", async () => {
  delete envHandle.PULSAR_MODEL_STUB;
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    let n = 0;
    modelAnswer = () => {
      if (++n > 1) return completion({ moves: [] });
      mock.timers.tick(280_000);
      return sse(JSON.stringify({ context: [], goals: holderDraft() }));
    };
    const lines = await ndjson(await route.POST(request({ text: PLAN_TEXT })));
    assert.ok(lastLine(lines).done, "the plan still arrives as the read left it");
    assert.equal(modelCalls.length, 1, "only the read went to the model");
  } finally {
    mock.timers.reset();
  }
});
