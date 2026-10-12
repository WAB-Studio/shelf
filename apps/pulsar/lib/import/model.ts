import { readFile } from "node:fs/promises";

// No `server-only` import: the unit suite cannot load it. The key is a server
// variable of `@/lib/env`, which refuses to read it in a client bundle.
import { env } from "@/lib/env";

import { importDraftJsonSchema, importDraftSchema, inMinutes, type ImportDraftV1 } from "./draft";
import { modelStub, type ModelStub } from "./model-seam";

export const MODEL_NAME = "gpt-5-mini";

const CHAT_COMPLETIONS_ENDPOINT = "https://api.openai.com/v1/chat/completions";

// Unmeasured: no call has been made. A plan of twelve goals is a few thousand
// tokens of JSON; the rest is headroom for reasoning, which counts against
// this budget and truncates the JSON to nothing when it runs out.
const MAX_OUTPUT_TOKENS = 16000;

const REASONING_EFFORT = "low";

const REQUEST_TIMEOUT_MS = 120_000;

export type PlanInput =
  | { kind: "text"; text: string }
  | { kind: "file"; name: string; type: string; bytes: Uint8Array };

type Usage = { input: number; output: number };

export type PlanReading =
  | { status: "ok"; draft: ImportDraftV1; usage: Usage }
  | { status: "failed" | "invalid" | "empty" | "unreadableType"; usage?: Usage };

type ChatCompletionsPayload = {
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

const SYSTEM_PROMPT =
  `You read a personal plan and return it as JSON shaped exactly by the given schema. ` +
  `Extract goals, their phases, month amounts, commitments, and tasks with estimates and sub-tasks. ` +
  `Write every time amount in minutes. Write every date as YYYY-MM-DD and every month as YYYY-MM. ` +
  `A goal's horizon is the day after its last day: a plan running until March 31, 2027 has horizon 2027-04-01. ` +
  `Invent nothing: a figure or date the plan does not state is null where the schema allows it, and ` +
  `a part the plan does not mention is an empty array. Keep the plan's own language for names.`;

// Strict mode wants every key required and no extra keys on every object;
// `$schema` is not part of its subset. The shape of `importDraftJsonSchema`
// already nulls what is absent, so this enforces the two rules at depth.
// Length, count and range bounds are left to `importDraftSchema`, which judges
// the answer unchanged; `pattern`, `format` and `enum` stay.
const STRIPPED_KEYS = new Set(["$schema", "minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum"]);

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (node === null || typeof node !== "object") return node;
  const entries = Object.entries(node as Record<string, unknown>)
    .filter(([key]) => !STRIPPED_KEYS.has(key))
    .map(([key, value]) => [key, strictify(value)] as const);
  const out = Object.fromEntries(entries) as Record<string, unknown>;
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  return out;
}

export const importDraftStrictSchema = strictify(importDraftJsonSchema);

const TEXT_EXTENSIONS = [".txt", ".md", ".markdown", ".csv", ".json"];
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export type FileRoute = "text" | "pdf" | "image" | null;
type Route = FileRoute;

// Chat completions takes a PDF as a file part and nothing else of a document:
// a .docx is refused here rather than sent to be rejected.
export function fileRoute(name: string, type: string): Route {
  const mime = type.toLowerCase().split(";")[0].trim();
  const lower = name.toLowerCase();
  if (mime === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (IMAGE_TYPES.includes(mime)) return "image";
  if (mime.startsWith("text/") || mime === "application/json" || TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return "text";
  }
  return null;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function userContent(input: PlanInput, route: Exclude<Route, null>): unknown[] {
  if (input.kind === "text") return [{ type: "text", text: input.text }];
  if (route === "text") return [{ type: "text", text: new TextDecoder().decode(input.bytes) }];
  const mime = route === "pdf" ? "application/pdf" : input.type.toLowerCase().split(";")[0].trim();
  const dataUrl = `data:${mime};base64,${toBase64(input.bytes)}`;
  if (route === "pdf") return [{ type: "file", file: { filename: input.name, file_data: dataUrl } }];
  return [{ type: "image_url", image_url: { url: dataUrl } }];
}

function judge(content: unknown, usage: Usage | undefined): PlanReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof content === "string" ? content : "");
  } catch {
    return { status: "failed", usage };
  }
  const goals = (parsed as { goals?: unknown } | null)?.goals;
  if (Array.isArray(goals) && goals.length === 0) return { status: "empty", usage };
  const result = importDraftSchema.safeParse(parsed);
  if (!result.success) return { status: "invalid", usage };
  return { status: "ok", draft: inMinutes(result.data), usage: usage ?? { input: 0, output: 0 } };
}

async function answerFromStub(stub: ModelStub): Promise<PlanReading> {
  if (stub.kind === "fail") return { status: "failed" };
  if (stub.kind === "empty") return { status: "empty" };
  if (stub.kind === "invalid") return { status: "invalid" };
  try {
    return judge(await readFile(stub.path, "utf8"), { input: 0, output: 0 });
  } catch {
    return { status: "failed" };
  }
}

function stubNow(): ModelStub | null {
  return modelStub(env.PULSAR_MODEL_STUB, process.env.VERCEL);
}

export function modelAvailable(): boolean {
  return Boolean(env.OPENAI_API_KEY) || stubNow() !== null;
}

/**
 * One call: a pasted text or an uploaded file in, a draft that passed
 * `importDraftSchema` out. Text-like files are decoded here; a PDF and an image
 * go to the model as parts, never parsed. Never throws: every failure is a
 * named status, so the screen's own notice is the only way one reaches a person.
 */
export async function readPlan(input: PlanInput): Promise<PlanReading> {
  const route: Route = input.kind === "text" ? "text" : fileRoute(input.name, input.type);
  if (route === null) return { status: "unreadableType" };
  if (input.kind === "text" && input.text.trim() === "") return { status: "empty" };

  const stub = stubNow();
  if (stub) return answerFromStub(stub);

  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return { status: "failed" };

  const body = {
    model: MODEL_NAME,
    reasoning_effort: REASONING_EFFORT,
    max_completion_tokens: MAX_OUTPUT_TOKENS,
    response_format: {
      type: "json_schema",
      json_schema: { name: "import_draft", schema: importDraftStrictSchema, strict: true },
    },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent(input, route) },
    ],
  };

  try {
    const response = await fetch(CHAT_COMPLETIONS_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return { status: "failed" };

    const payload = (await response.json()) as ChatCompletionsPayload;
    const usage =
      payload.usage?.prompt_tokens !== undefined || payload.usage?.completion_tokens !== undefined
        ? { input: payload.usage?.prompt_tokens ?? 0, output: payload.usage?.completion_tokens ?? 0 }
        : undefined;
    const choice = payload.choices?.[0];
    if (choice?.finish_reason === "length" || choice?.message?.refusal) return { status: "failed", usage };
    return judge(choice?.message?.content, usage);
  } catch {
    return { status: "failed" };
  }
}
