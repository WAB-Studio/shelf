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
import { after, before, beforeEach, test } from "node:test";

import ExcelJS from "exceljs";
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
let modelAnswer: () => Response = () => new Response("unset", { status: 500 });

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
    return modelAnswer();
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
  assert.deepEqual(draft.goals.map((g) => g.name), ["Carrera en IA", "IA aplicada", "Evals y harness"]);
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

test("a PDF goes as parts: the source comes back with no lines to copy", async () => {
  stubDraft(rawGoal({ src: [] }));
  const file = new File([new Uint8Array([37, 80, 68, 70])], "plan.pdf", { type: "application/pdf" });
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
      headers: { "content-type": "text/plain" },
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
const xlsx = (bytes: Uint8Array, name = "plantilla-pulsar.xlsx") => new File([bytes as BlobPart], name, { type: XLSX });

test("the delivered workbook, uploaded: 200 via workbook with its draft; no key, no row, no model", async () => {
  delete envHandle.OPENAI_API_KEY;
  delete envHandle.PULSAR_MODEL_STUB;
  const { templateWorkbook } = await import("@/lib/import/workbook");
  const response = await route.POST(request({ file: xlsx(await templateWorkbook()) }));
  assert.equal(response.status, 200);
  const body = await answer(response);
  assert.equal(body.via, "workbook");
  const draft = body.draft as { version: number; goals: { name: string; parent: string | null }[] };
  assert.equal(draft.version, 2);
  assert.deepEqual(draft.goals.map((g) => g.name), ["Carrera en IA", "IA aplicada", "Evals y harness"]);
  assert.deepEqual(body.source, { kind: "rows", lines: null });
  assert.ok(Array.isArray(body.corrections) && Array.isArray(body.notices));
  assert.equal((await rows()).length, 0);
  assert.equal(modelCalls.length, 0);
});

test("a workbook with a broken row: 422 workbookRows names its sheet and row; no row, no model", async () => {
  const { templateWorkbook } = await import("@/lib/import/workbook");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await templateWorkbook()) as never);
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
  const response = await route.POST(request({ file: xlsx(await templateWorkbook()) }));
  assert.equal(response.status, 200);
  assert.equal((await rows()).length, 10);
});

test("the download: GET /importar/plantilla.xlsx hands the workbook as an attachment, signed out, with no row", async () => {
  standing = [];
  const download = await import("@/app/importar/plantilla.xlsx/route");
  const response = await download.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-disposition"), "attachment; filename=plantilla-pulsar.xlsx");
  assert.equal(response.headers.get("content-type"), XLSX);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const { readWorkbook } = await import("@/lib/import/workbook");
  const read = await readWorkbook(bytes);
  assert.ok(read.matched && "draft" in read, "the bytes are a workbook the reader takes");
  assert.equal(read.draft.goals.length, 3);
  assert.equal((await rows()).length, 0);
});
