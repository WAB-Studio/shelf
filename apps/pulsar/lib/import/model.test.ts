import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, mock } from "node:test";

import type { RawDraft } from "./draft";

const fakeEnv: { OPENAI_API_KEY?: string; PULSAR_MODEL_STUB?: string } = {};
mock.module("@/lib/env", { namedExports: { env: fakeEnv } });

const goal: RawDraft["goals"][number] = {
  key: "g1",
  parent: null,
  name: "IA aplicada",
  horizon: "2027-10-01",
  measure: { name: "estudio", unit: "horas" },
  rate: null,
  noteSrc: [],
  noteText: null,
  src: [{ from: 1, to: 2 }],
  phases: [],
  months: [],
  commitments: [],
  rules: [],
  tasks: [{ name: "Leer", month: "2026-10", estimate: 4, week: null, rule: null, noteSrc: [], noteText: null, src: [{ from: 2, to: 2 }], children: [] }],
};
const answer = { context: [{ what: "Un diagnóstico", src: [{ from: 1, to: 1 }] }], goals: [goal] };

type Call = { url: string; init: RequestInit };
const calls: Call[] = [];
const realFetch = globalThis.fetch;
const realVercel = process.env.VERCEL;

function replyWith(make: () => Response | Promise<Response>) {
  calls.length = 0;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return make();
  }) as typeof fetch;
}

type Tail = { finish?: string; refusal?: string; usage?: object | null };

// A streamed answer: one server-sent event per piece, then the finish and the usage.
// `delivered` counts the pieces the reader has asked for (no read-ahead).
function streamOf(pieces: string[], tail: Tail = {}, delivered = { n: 0 }): Response {
  const events: string[] = pieces.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  if (tail.refusal) events.push(`data: ${JSON.stringify({ choices: [{ delta: { refusal: tail.refusal } }] })}\n\n`);
  events.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: tail.finish ?? "stop" }] })}\n\n`);
  const usage = tail.usage === undefined ? { prompt_tokens: 120, completion_tokens: 340 } : tail.usage;
  if (usage) events.push(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
  events.push("data: [DONE]\n\n");
  let i = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (i >= events.length) return controller.close();
        controller.enqueue(new TextEncoder().encode(events[i++]));
        if (i <= pieces.length) delivered.n = i;
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const whole = (value: unknown, tail?: Tail) => streamOf([typeof value === "string" ? value : JSON.stringify(value)], tail);
const bodyOf = (call: Call) => JSON.parse(call.init.body as string);
const noSteps = () => {};

afterEach(() => {
  globalThis.fetch = realFetch;
  delete fakeEnv.OPENAI_API_KEY;
  delete fakeEnv.PULSAR_MODEL_STUB;
  if (realVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = realVercel;
  calls.length = 0;
});

const readText = async (text = "plan", onStep: (s: "find" | "arrange") => void = noSteps) =>
  (await import("./model")).readPlan({ kind: "text", text }, onStep);

test("the request asks gpt-5.5 at medium effort, streamed, strict, with the key", async () => {
  const { MODEL_NAME } = await import("./model");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => whole(answer));

  const result = await readText("# Mi plan\n- aprender");

  assert.equal(result.status, "ok");
  assert.equal(MODEL_NAME, "gpt-5.5");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer sk-test");
  const body = bodyOf(calls[0]);
  assert.equal(body.model, "gpt-5.5");
  assert.equal(body.reasoning_effort, "medium");
  assert.equal(body.stream, true);
  assert.equal(body.stream_options.include_usage, true);
  assert.equal(body.max_completion_tokens, 32000);
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.messages[0].role, "system");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("the text goes numbered line by line, the 741st with its number", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => whole(answer));
  const text = Array.from({ length: 800 }, (_, i) => `línea ${i + 1}`).join("\n");

  await readText(text);

  const sent: string = bodyOf(calls[0]).messages[1].content[0].text;
  assert.ok(sent.startsWith("1|línea 1\n"));
  assert.ok(sent.split("\n")[740] === "741|línea 741");
});

test("a text file is decoded and numbered the same way", async () => {
  const { readPlan } = await import("./model");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => whole(answer));

  await readPlan({ kind: "file", name: "plan.md", type: "", bytes: new TextEncoder().encode("# Plan\nuno") }, noSteps);

  assert.deepEqual(bodyOf(calls[0]).messages[1].content, [{ type: "text", text: "1|# Plan\n2|uno" }]);
});

test("the schema names each limit: 120 on a task name, 7 on times per week, 40 goals", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => whole(answer));
  await readText();
  const schema = bodyOf(calls[0]).response_format.json_schema.schema;

  const goals = schema.properties.goals;
  const task = goals.items.properties.tasks.items;
  const child = task.properties.children.items;
  const cadence = goals.items.properties.commitments.items.properties.cadenceN;
  const mentions = (node: unknown, n: number) => new RegExp(`\\b${n}\\b`).test(JSON.stringify(node));
  assert.ok(mentions(task.properties.name, 120));
  assert.ok(mentions(child.properties.name, 120));
  assert.ok(mentions(goals.items.properties.name, 120));
  assert.ok(mentions(cadence, 7));
  assert.ok(mentions(goals, 40));
  assert.ok(/hours|horas/i.test(JSON.stringify(task.properties.estimate)));
  assert.ok(/three|tres|3/i.test(JSON.stringify(goals.items.properties.parent)));
});

test("the schema asks context before goals and stays strict", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => whole(answer));
  await readText();
  const schema = bodyOf(calls[0]).response_format.json_schema.schema;

  assert.deepEqual(Object.keys(schema.properties), ["context", "goals"]);
  assert.deepEqual(schema.required, ["context", "goals"]);
  assert.equal(schema.additionalProperties, false);
  assert.equal("$schema" in schema, false);
});

test("the step is find on sending and arrange exactly when goals opens", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  const delivered = { n: 0 };
  const seen: Array<[string, number]> = [];
  // The word «goals» sits in a value of the first piece: it opens nothing.
  const pieces = ['{"context":[{"what":"my goals","src":[]}],"go', 'als":', "[]}"];
  replyWith(() => streamOf(pieces, {}, delivered));

  await readText("plan", (step) => seen.push([step, delivered.n]));

  assert.deepEqual(seen, [
    ["find", 0],
    ["arrange", 2],
  ]);
});

test("arrange is announced once even when goals comes whole in one piece", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  const seen: string[] = [];
  replyWith(() => whole(answer));

  await readText("plan", (step) => seen.push(step));

  assert.deepEqual(seen, ["find", "arrange"]);
});

test("a name of 150 characters is ok and comes back raw; the context key is dropped", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  const long = { ...goal, name: "x".repeat(150), tasks: [{ ...goal.tasks[0], name: "y".repeat(150) }] };
  replyWith(() => whole({ context: [], goals: [long] }));

  const result = await readText();

  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.raw.goals[0].name.length, 150);
    assert.equal(result.raw.goals[0].tasks[0].name.length, 150);
    assert.equal("context" in result.raw, false);
    assert.deepEqual(result.source, { kind: "lines", lines: ["plan"] });
    assert.deepEqual(result.usage, { input: 120, output: 340 });
  }
});

test("nine times a week is ok too", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  const commitment = { name: "Leer", cadenceKind: "times_per_week", cadenceWeekdays: null, cadenceN: 9, satisfaction: "tap", targetQuantity: null, unit: null, src: [] };
  replyWith(() => whole({ context: [], goals: [{ ...goal, commitments: [commitment] }] }));

  assert.equal((await readText()).status, "ok");
});

test("a type that does not match answers invalid with its usage", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => whole({ context: [], goals: "texto" }));

  const result = await readText();

  assert.equal(result.status, "invalid");
  assert.deepEqual(result.usage, { input: 120, output: 340 });
});

test("a goal missing a field answers invalid", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  const { tasks: _tasks, ...missing } = goal;
  void _tasks;
  replyWith(() => whole({ context: [], goals: [missing] }));

  assert.equal((await readText()).status, "invalid");
});

test("{ goals: [] } answers empty", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => whole({ context: [], goals: [] }));

  assert.equal((await readText()).status, "empty");
});

test("finish_reason length answers failed with its usage, though the content would parse", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => whole(answer, { finish: "length" }));

  const result = await readText();

  assert.equal(result.status, "failed");
  assert.deepEqual(result.usage, { input: 120, output: 340 });
});

test("a refusal answers failed though the content would parse", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => whole(answer, { refusal: "no" }));

  assert.equal((await readText()).status, "failed");
});

test("an HTTP error, a network error and a body that is not JSON answer failed", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";

  replyWith(() => new Response("boom", { status: 500 }));
  assert.equal((await readText()).status, "failed");

  replyWith(() => new Response("x", { status: 429 }));
  assert.equal((await readText()).status, "failed");

  replyWith(() => {
    throw new TypeError("fetch failed");
  });
  assert.equal((await readText()).status, "failed");

  replyWith(() => whole("not json at all"));
  assert.equal((await readText()).status, "failed");
});

test("a stream cut off mid-way answers failed", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"context":' } }] })}\n\n`));
        controller.error(new TypeError("terminated"));
      },
    });
    return new Response(body);
  });

  assert.equal((await readText()).status, "failed");
});

test("usage is read exactly: whole, partial and absent", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";

  replyWith(() => whole(answer, { usage: { prompt_tokens: 7, completion_tokens: 9 } }));
  const full = await readText();
  assert.deepEqual(full.usage, { input: 7, output: 9 });

  replyWith(() => whole(answer, { usage: { completion_tokens: 9 } }));
  assert.deepEqual((await readText()).usage, { input: 0, output: 9 });

  replyWith(() => whole(answer, { usage: null }));
  const absent = await readText();
  assert.equal(absent.status, "ok");
  assert.deepEqual(absent.usage, { input: 0, output: 0 });
});

test("blank text answers empty with no call and no step", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => whole(answer));
  const seen: string[] = [];

  assert.equal((await readText("", (s) => seen.push(s))).status, "empty");
  assert.equal((await readText(" \n\t ")).status, "empty");
  assert.equal(calls.length, 0);
  assert.deepEqual(seen, []);
});

test("a PDF goes as a file part and its source is parts", async () => {
  const { readPlan } = await import("./model");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => whole(answer));
  const bytes = new Uint8Array([37, 80, 68, 70, 45]);

  const result = await readPlan({ kind: "file", name: "plan.pdf", type: "application/pdf", bytes }, noSteps);

  assert.deepEqual(bodyOf(calls[0]).messages[1].content, [
    { type: "file", file: { filename: "plan.pdf", file_data: `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}` } },
  ]);
  assert.equal(result.status === "ok" && result.source.kind, "parts");
  assert.equal(result.status === "ok" && result.source.lines, null);
});

test("an image goes as an image_url and its source is parts", async () => {
  const { readPlan } = await import("./model");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => whole(answer));

  const result = await readPlan({ kind: "file", name: "plan.png", type: "image/png", bytes: new Uint8Array([1, 2, 3]) }, noSteps);

  assert.deepEqual(bodyOf(calls[0]).messages[1].content, [{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }]);
  assert.equal(result.status === "ok" && result.source.kind, "parts");
});

test("fileRoute tells every kind, the workbook included", async () => {
  const { fileRoute } = await import("./model");
  assert.equal(fileRoute("p.xlsx", ""), "workbook");
  assert.equal(fileRoute("p", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "workbook");
  assert.equal(fileRoute("PLAN.PDF", "application/octet-stream"), "pdf");
  assert.equal(fileRoute("x", "Application/PDF; charset=binary"), "pdf");
  assert.equal(fileRoute("x", "IMAGE/PNG; charset=binary"), "image");
  assert.equal(fileRoute("x", "text/markdown; charset=utf-8"), "text");
  for (const name of ["a.txt", "a.md", "a.markdown", "a.csv", "a.json"]) assert.equal(fileRoute(name, ""), "text", name);
  assert.equal(fileRoute("p.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), null);
  assert.equal(fileRoute("x.xyz", "application/octet-stream"), null);
});

test("a .docx answers unreadableType with no call", async () => {
  const { readPlan } = await import("./model");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => whole(answer));

  const result = await readPlan({ kind: "file", name: "plan.docx", type: "", bytes: new Uint8Array([1]) }, noSteps);

  assert.equal(result.status, "unreadableType");
  assert.equal(calls.length, 0);
});

test("a stub answers the raw fixture with both steps in order and no fetch", async () => {
  const { readPlan, modelAvailable } = await import("./model");
  delete process.env.VERCEL;
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => whole(answer));
  const dir = mkdtempSync(join(tmpdir(), "stub-"));
  const path = join(dir, "draft.json");
  writeFileSync(path, JSON.stringify({ goals: [goal] }));
  const seen: string[] = [];

  fakeEnv.PULSAR_MODEL_STUB = `draft:${path}`;
  const ok = await readPlan({ kind: "text", text: "uno\ndos" }, (s) => seen.push(s));
  assert.equal(ok.status, "ok");
  if (ok.status === "ok") {
    assert.deepEqual(ok.raw.goals[0], goal);
    assert.deepEqual(ok.source, { kind: "lines", lines: ["uno", "dos"] });
  }
  assert.deepEqual(seen, ["find", "arrange"]);

  fakeEnv.PULSAR_MODEL_STUB = "fail";
  assert.equal((await readText()).status, "failed");
  fakeEnv.PULSAR_MODEL_STUB = "invalid";
  assert.equal((await readText()).status, "invalid");
  fakeEnv.PULSAR_MODEL_STUB = "empty";
  assert.equal((await readText()).status, "empty");

  delete fakeEnv.OPENAI_API_KEY;
  fakeEnv.PULSAR_MODEL_STUB = `draft:${path}`;
  assert.equal(modelAvailable(), true);
  assert.equal(calls.length, 0);
});

test("a stub whose fixture does not exist answers failed", async () => {
  delete process.env.VERCEL;
  fakeEnv.PULSAR_MODEL_STUB = "draft:/nonexistent/draft.json";

  assert.equal((await readText()).status, "failed");
});

test("no key and no stub: unavailable, failed, no call, no step", async () => {
  const { modelAvailable } = await import("./model");
  delete process.env.VERCEL;
  replyWith(() => whole(answer));
  const seen: string[] = [];

  assert.equal(modelAvailable(), false);
  assert.equal((await readText("plan", (s) => seen.push(s))).status, "failed");
  assert.equal(calls.length, 0);
  assert.deepEqual(seen, []);
});

test("under VERCEL the stub is off: the real call is made and the key rules", async () => {
  const { modelAvailable } = await import("./model");
  process.env.VERCEL = "1";
  fakeEnv.PULSAR_MODEL_STUB = "fail";
  replyWith(() => whole(answer));

  assert.equal(modelAvailable(), false);
  fakeEnv.OPENAI_API_KEY = "sk-test";
  assert.equal((await readText()).status, "ok");
  assert.equal(calls.length, 1);
});

test("898: a failed read logs the status and the error, never the plan or the key", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-secret-key";
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    replyWith(() => new Response('{"error":{"type":"insufficient_quota","code":"quota","message":"Incorrect API key provided: sk-secret-key"}}', { status: 429 }));
    assert.equal((await readText("el texto del plan de la persona")).status, "failed");
    replyWith(() => {
      throw new TypeError("fetch failed");
    });
    assert.equal((await readText("el texto del plan de la persona")).status, "failed");
  } finally {
    console.error = realError;
  }
  const text = JSON.stringify(logged);
  assert.equal(logged.length, 2);
  assert.match(text, /429/);
  assert.match(text, /insufficient_quota/);
  assert.match(text, /TypeError|fetch failed/);
  assert.doesNotMatch(text, /sk-secret-key|el texto del plan/);
});

// ---- 903

// The same events as `streamOf`, cut into the byte pieces the network hands over.
function rawStream(text: string, cuts: number[]): Response {
  const bytes = new TextEncoder().encode(text);
  const edges = [0, ...cuts, bytes.length];
  let i = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (i + 1 >= edges.length) return controller.close();
        controller.enqueue(bytes.slice(edges[i], edges[i + 1]));
        i++;
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const eventsOf = (content: string, usage: object | null = { prompt_tokens: 12, completion_tokens: 34 }, end = "\n\n") =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
  (usage ? `data: ${JSON.stringify({ choices: [], usage })}${end}` : "");

test("903: an event cut across two chunks is read whole", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  const text = eventsOf(JSON.stringify(answer));
  replyWith(() => rawStream(text, [10, 40, text.indexOf("finish_reason") + 3]));
  const result = await readText();
  assert.equal(result.status, "ok");
  assert.deepEqual(result.usage, { input: 12, output: 34 });
});

test("903: a keep-alive comment line between events is ignored", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => rawStream(`: keep-alive\n\n${eventsOf(JSON.stringify(answer))}`, []));
  assert.equal((await readText()).status, "ok");
});

test("903: a last event with no newline after it still counts", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => rawStream(eventsOf(JSON.stringify(answer), { prompt_tokens: 5, completion_tokens: 6 }, ""), []));
  const result = await readText();
  assert.equal(result.status, "ok");
  assert.deepEqual(result.usage, { input: 5, output: 6 });
});

test("903: a usage chunk with only the prompt side settles the output as 0", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => whole(answer, { usage: { prompt_tokens: 5 } }));
  assert.deepEqual((await readText()).usage, { input: 5, output: 0 });
});

test("903: the read waits four minutes before it aborts", async () => {
  const { REQUEST_TIMEOUT_MS } = await import("./model");
  assert.equal(REQUEST_TIMEOUT_MS, 240_000);
});

test("903: the schema bounds 40 goals and a cadence count from 1 to 365", async () => {
  const { rawDraftStrictSchema } = await import("./model");
  const goals = (rawDraftStrictSchema as { properties: { goals: { maxItems: number; items: { properties: { commitments: { items: { properties: { cadenceN: { anyOf: { type: string; minimum?: number; maximum?: number }[] } } } } } } } } }).properties.goals;
  assert.equal(goals.maxItems, 40);
  const integer = goals.items.properties.commitments.items.properties.cadenceN.anyOf.find((branch) => branch.type === "integer");
  assert.deepEqual([integer?.minimum, integer?.maximum], [1, 365]);
});

test("fileRefused: bytes that are not what the type says, a long PDF and a huge image are refused", async () => {
  const { fileRefused, pdfPages, imagePixels } = await import("./model");
  const pdf = (pages: number) => new TextEncoder().encode(`%PDF-1.4\n${"<< /Type /Page >>\n".repeat(pages)}<< /Type /Pages /Count ${pages} >>`);
  assert.equal(pdfPages(pdf(3)), 3);
  assert.equal(fileRefused("pdf", pdf(40)), false);
  assert.equal(fileRefused("pdf", pdf(41)), true);
  assert.equal(fileRefused("pdf", new TextEncoder().encode("not a pdf")), true);
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(32);
    b.writeUInt32BE(0x89504e47, 0);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return new Uint8Array(b);
  };
  assert.equal(imagePixels(png(1000, 2000)), 2_000_000);
  assert.equal(fileRefused("image", png(4000, 4000)), false);
  assert.equal(fileRefused("image", png(10000, 10000)), true);
  assert.equal(fileRefused("image", new TextEncoder().encode("text")), true);
  assert.equal(fileRefused("text", new Uint8Array([1])), false);
});
