import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, mock } from "node:test";

import type { ImportDraftV1 } from "./draft";

const fakeEnv: { OPENAI_API_KEY?: string; PULSAR_MODEL_STUB?: string } = {};
mock.module("@/lib/env", { namedExports: { env: fakeEnv } });

const goal: ImportDraftV1["goals"][number] = {
  name: "IA aplicada",
  horizon: "2027-10-01",
  rhythm: null,
  measure: { name: "horas de estudio", unit: "minutos" },
  phases: [{ aim: "Evals", startsOn: "2026-10-01", endsOn: "2026-12-31" }],
  months: [{ month: "2026-10", amount: 720 }],
  commitments: [],
  tasks: [{ name: "Leer", month: "2026-10", estimate: 240, children: [] }],
};

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

const completion = (content: unknown, extra: object = {}) =>
  Response.json({
    choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 340 },
    ...extra,
  });

const bodyOf = (call: Call) => JSON.parse(call.init.body as string);

afterEach(() => {
  globalThis.fetch = realFetch;
  delete fakeEnv.OPENAI_API_KEY;
  delete fakeEnv.PULSAR_MODEL_STUB;
  if (realVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = realVercel;
  calls.length = 0;
});

test("a Markdown text posts to chat completions with the key, the model, json_schema and the text", async () => {
  const { readPlan, MODEL_NAME } = await import("./model");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => completion({ goals: [goal] }));

  const result = await readPlan({ kind: "text", text: "# Mi plan\n- aprender" });

  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.deepEqual(result.draft.goals[0], goal);
    assert.deepEqual(result.usage, { input: 120, output: 340 });
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer sk-test");
  const body = bodyOf(calls[0]);
  assert.equal(body.model, MODEL_NAME);
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.messages[1].content, [{ type: "text", text: "# Mi plan\n- aprender" }]);
});

test("the strict schema names every key as required and closes every object", async () => {
  const { importDraftStrictSchema } = await import("./model");
  const seen: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.type === "object") {
      assert.equal(obj.additionalProperties, false);
      assert.deepEqual(obj.required, Object.keys(obj.properties as object));
      seen.push("object");
    }
    Object.values(obj).forEach(walk);
  };
  walk(importDraftStrictSchema);
  assert.ok(seen.length >= 6);
  assert.equal("$schema" in (importDraftStrictSchema as object), false);
  assert.equal(JSON.stringify(importDraftStrictSchema).includes('"note"'), false);
});

test("a Markdown file is decoded here and sent as text", async () => {
  const { readPlan } = await import("./model");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => completion({ goals: [goal] }));

  await readPlan({ kind: "file", name: "plan.md", type: "", bytes: new TextEncoder().encode("# Plan") });

  assert.deepEqual(bodyOf(calls[0]).messages[1].content, [{ type: "text", text: "# Plan" }]);
});

test("a PDF posts a file part with a base64 data URL and its filename", async () => {
  const { readPlan } = await import("./model");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => completion({ goals: [goal] }));
  const bytes = new Uint8Array([37, 80, 68, 70, 45]);

  await readPlan({ kind: "file", name: "plan.pdf", type: "application/pdf", bytes });

  assert.deepEqual(bodyOf(calls[0]).messages[1].content, [
    { type: "file", file: { filename: "plan.pdf", file_data: `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}` } },
  ]);
});

test("an image posts an image_url part with a data URL", async () => {
  const { readPlan } = await import("./model");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => completion({ goals: [goal] }));

  await readPlan({ kind: "file", name: "plan.png", type: "image/png", bytes: new Uint8Array([1, 2, 3]) });

  assert.deepEqual(bodyOf(calls[0]).messages[1].content, [
    { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
  ]);
});

test("a .docx answers unreadableType with no call", async () => {
  const { readPlan } = await import("./model");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => completion({ goals: [goal] }));

  const result = await readPlan({
    kind: "file",
    name: "plan.docx",
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: new Uint8Array([1]),
  });

  assert.equal(result.status, "unreadableType");
  assert.equal(calls.length, 0);
});

test("an HTTP 500, a network error and a non-JSON body answer failed", async () => {
  const { readPlan } = await import("./model");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  const input = { kind: "text", text: "plan" } as const;

  replyWith(() => new Response("boom", { status: 500 }));
  assert.equal((await readPlan(input)).status, "failed");

  replyWith(() => {
    throw new TypeError("fetch failed");
  });
  assert.equal((await readPlan(input)).status, "failed");

  replyWith(() => new Response("<html>not json</html>", { status: 200 }));
  assert.equal((await readPlan(input)).status, "failed");

  replyWith(() => completion("not json at all"));
  assert.equal((await readPlan(input)).status, "failed");
});

test("an answer missing a field answers invalid", async () => {
  const { readPlan } = await import("./model");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  const missing: Partial<typeof goal> = { ...goal };
  delete missing.tasks;
  replyWith(() => completion({ goals: [missing] }));

  const result = await readPlan({ kind: "text", text: "plan" });

  assert.equal(result.status, "invalid");
  assert.deepEqual(result.usage, { input: 120, output: 340 });
});

test("{ goals: [] } answers empty", async () => {
  const { readPlan } = await import("./model");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => completion({ goals: [] }));

  assert.equal((await readPlan({ kind: "text", text: "plan" })).status, "empty");
});

test("a truncated answer (finish_reason length) answers failed", async () => {
  const { readPlan } = await import("./model");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => Response.json({ choices: [{ message: { content: '{"goals":[' }, finish_reason: "length" }] }));

  assert.equal((await readPlan({ kind: "text", text: "plan" })).status, "failed");
});

test("no key and no stub: unavailable, and readPlan answers failed with no call", async () => {
  const { readPlan, modelAvailable } = await import("./model");
  delete process.env.VERCEL;
  replyWith(() => completion({ goals: [goal] }));

  assert.equal(modelAvailable(), false);
  assert.equal((await readPlan({ kind: "text", text: "plan" })).status, "failed");
  assert.equal(calls.length, 0);
});

test("a stub answers before fetch: draft file, fail, invalid, empty", async () => {
  const { readPlan, modelAvailable } = await import("./model");
  delete process.env.VERCEL;
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => completion({ goals: [goal] }));
  const dir = mkdtempSync(join(tmpdir(), "stub-"));
  const path = join(dir, "draft.json");
  writeFileSync(path, JSON.stringify({ goals: [goal] }));
  const input = { kind: "text", text: "plan" } as const;

  fakeEnv.PULSAR_MODEL_STUB = `draft:${path}`;
  const ok = await readPlan(input);
  assert.equal(ok.status, "ok");
  if (ok.status === "ok") assert.deepEqual(ok.draft.goals[0], goal);

  fakeEnv.PULSAR_MODEL_STUB = "fail";
  assert.equal((await readPlan(input)).status, "failed");
  fakeEnv.PULSAR_MODEL_STUB = "invalid";
  assert.equal((await readPlan(input)).status, "invalid");
  fakeEnv.PULSAR_MODEL_STUB = "empty";
  assert.equal((await readPlan(input)).status, "empty");

  delete fakeEnv.OPENAI_API_KEY;
  assert.equal(modelAvailable(), true);
  assert.equal(calls.length, 0);
});

test("a stub whose fixture does not exist answers failed", async () => {
  const { readPlan } = await import("./model");
  delete process.env.VERCEL;
  fakeEnv.PULSAR_MODEL_STUB = "draft:/nonexistent/draft.json";

  assert.equal((await readPlan({ kind: "text", text: "plan" })).status, "failed");
});

test("under VERCEL the stub is off: the real call is made and the key rules", async () => {
  const { readPlan, modelAvailable } = await import("./model");
  process.env.VERCEL = "1";
  fakeEnv.PULSAR_MODEL_STUB = "fail";
  replyWith(() => completion({ goals: [goal] }));

  assert.equal(modelAvailable(), false);
  fakeEnv.OPENAI_API_KEY = "sk-test";
  const result = await readPlan({ kind: "text", text: "plan" });

  assert.equal(result.status, "ok");
  assert.equal(calls.length, 1);
});

const valid = () => completion({ goals: [goal] });
const readText = async () => (await import("./model")).readPlan({ kind: "text", text: "plan" });

test("the strict schema carries none of the stripped bounds and keeps pattern and enum", async () => {
  const { importDraftStrictSchema } = await import("./model");
  const stripped = ["minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum", "$schema"];
  const keys = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as object)) {
      if (key !== "properties") keys.add(key);
      walk(value);
    }
  };
  walk(importDraftStrictSchema);
  for (const key of stripped) assert.equal(keys.has(key), false, key);
  assert.ok(keys.has("pattern"));
  assert.ok(keys.has("enum"));
});

test("a refusal answers failed even when the content would parse", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() =>
    Response.json({ choices: [{ message: { content: JSON.stringify({ goals: [goal] }), refusal: "no" }, finish_reason: "stop" }] }),
  );
  assert.equal((await readText()).status, "failed");
});

test("finish_reason length answers failed even when the content would parse", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() =>
    Response.json({ choices: [{ message: { content: JSON.stringify({ goals: [goal] }) }, finish_reason: "length" }] }),
  );
  assert.equal((await readText()).status, "failed");
});

test("a non-2xx status answers failed even when the body would parse", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(() => Response.json({ choices: [{ message: { content: JSON.stringify({ goals: [goal] }) }, finish_reason: "stop" }] }, { status: 429 }));
  assert.equal((await readText()).status, "failed");
});

test("blank text answers empty with no call", async () => {
  const { readPlan } = await import("./model");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(valid);
  assert.equal((await readPlan({ kind: "text", text: "" })).status, "empty");
  assert.equal((await readPlan({ kind: "text", text: " \n\t " })).status, "empty");
  assert.equal(calls.length, 0);
});

async function contentOf(name: string, type: string, bytes = new Uint8Array([1, 2, 3])) {
  const { readPlan } = await import("./model");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(valid);
  const result = await readPlan({ kind: "file", name, type, bytes });
  return { result, content: calls[0] ? bodyOf(calls[0]).messages[1].content : null };
}

test("a PDF is told by its mime alone and by its extension alone", async () => {
  const byMime = await contentOf("plan", "application/pdf");
  assert.equal(byMime.content[0].type, "file");
  const byExtension = await contentOf("PLAN.PDF", "application/octet-stream");
  assert.equal(byExtension.content[0].type, "file");
  assert.equal(byExtension.content[0].file.file_data, "data:application/pdf;base64,AQID");
});

test("a mime parameter is stripped: charset on text, on a PDF and on an image", async () => {
  const text = await contentOf("x", "text/markdown; charset=utf-8", new TextEncoder().encode("hola"));
  assert.deepEqual(text.content, [{ type: "text", text: "hola" }]);
  const pdf = await contentOf("x", "Application/PDF; charset=binary");
  assert.equal(pdf.content[0].type, "file");
  const image = await contentOf("x", "IMAGE/PNG; charset=binary");
  assert.deepEqual(image.content, [{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }]);
});

test("text/plain and application/json are read as text with no extension to help", async () => {
  for (const type of ["text/plain", "application/json"]) {
    const { content } = await contentOf("x", type, new TextEncoder().encode("hola"));
    assert.deepEqual(content, [{ type: "text", text: "hola" }]);
  }
});

test("each text extension is read as text when the mime says nothing", async () => {
  for (const name of ["a.txt", "a.md", "a.markdown", "a.csv", "a.json"]) {
    const { content } = await contentOf(name, "", new TextEncoder().encode("hola"));
    assert.deepEqual(content, [{ type: "text", text: "hola" }], name);
  }
});

test("each accepted image type goes as an image_url with its own mime", async () => {
  for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
    const { content } = await contentOf("x", type);
    assert.deepEqual(content, [{ type: "image_url", image_url: { url: `data:${type};base64,AQID` } }], type);
  }
});

test("an unknown type with an unknown extension answers unreadableType with no call", async () => {
  const { result, content } = await contentOf("x.xyz", "application/octet-stream");
  assert.equal(result.status, "unreadableType");
  assert.equal(content, null);
});

test("modelAvailable is true with a key only", async () => {
  const { modelAvailable } = await import("./model");
  delete process.env.VERCEL;
  fakeEnv.OPENAI_API_KEY = "sk-test";
  assert.equal(modelAvailable(), true);
});

test("usage is read exactly: whole, partial, and absent", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  const content = JSON.stringify({ goals: [goal] });

  replyWith(() => Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 7, completion_tokens: 9 } }));
  const whole = await readText();
  assert.equal(whole.status === "ok" && whole.usage.input, 7);
  assert.equal(whole.status === "ok" && whole.usage.output, 9);

  replyWith(() => Response.json({ choices: [{ message: { content } }], usage: { completion_tokens: 9 } }));
  const partial = await readText();
  assert.deepEqual(partial.usage, { input: 0, output: 9 });

  replyWith(() => Response.json({ choices: [{ message: { content } }] }));
  const absent = await readText();
  assert.equal(absent.status, "ok");
  assert.deepEqual(absent.usage, { input: 0, output: 0 });

  replyWith(() => Response.json({ choices: [{ message: { content: JSON.stringify({ goals: [{}] }) } }] }));
  const invalid = await readText();
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.usage, undefined);
});

test("the request carries reasoning effort, an output budget, the schema name and a timeout signal", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  replyWith(valid);
  await readText();
  const body = bodyOf(calls[0]);
  assert.equal(body.reasoning_effort, "low");
  assert.equal(typeof body.max_completion_tokens, "number");
  assert.ok(body.max_completion_tokens > 0);
  assert.equal(body.response_format.json_schema.name, "import_draft");
  assert.equal(body.messages[0].role, "system");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.method, "POST");
  assert.equal((calls[0].init.headers as Record<string, string>)["content-type"], "application/json");
});

test("the model's answer in hours is read in minutes", async () => {
  const { readPlan } = await import("./model");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  const hours = { ...goal, measure: { name: "estudio", unit: "horas" }, months: [{ month: "2026-10", amount: 12 }] };
  replyWith(() => completion({ goals: [hours] }));
  const reading = await readPlan({ kind: "text", text: "plan" });
  assert.equal(reading.status, "ok");
  if (reading.status === "ok") {
    assert.equal(reading.draft.goals[0].measure?.unit, "minutos");
    assert.equal(reading.draft.goals[0].months[0].amount, 720);
  }
});
