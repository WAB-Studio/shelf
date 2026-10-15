import { readFile } from "node:fs/promises";

// No `server-only` import: the unit suite cannot load it. The key is a server
// variable of `@/lib/env`, which refuses to read it in a client bundle.
import { env } from "@/lib/env";

import { rawDraftJsonSchema, rawDraftSchema, type RawDraft, type Source } from "./draft";
import { modelStub, type ModelStub } from "./model-seam";
import { importSystemPrompt, numberLines, splitLines } from "./prompt";
import { todayInZone } from "@/lib/zone";

export const MODEL_NAME = "gpt-5.5";

const CHAT_COMPLETIONS_ENDPOINT = "https://api.openai.com/v1/chat/completions";

// Unmeasured: the answer grows with the source lines it copies, and reasoning counts
// against this budget. The orchestrator's paid run (Unresolved of the import plan) replaces both.
const MAX_OUTPUT_TOKENS = 32_000;

const REASONING_EFFORT = "medium";

export const REQUEST_TIMEOUT_MS = 240_000;

export type Step = "find" | "arrange";

export type PlanInput =
  | { kind: "text"; text: string }
  | { kind: "file"; name: string; type: string; bytes: Uint8Array };

export type Usage = { input: number; output: number };

export type PlanReading =
  | { status: "ok"; raw: RawDraft; source: Source; usage: Usage }
  | { status: "failed" | "invalid" | "empty" | "unreadableType"; usage?: Usage };

// Strict mode takes `minimum`, `maximum`, `minItems` and `maxItems` but no `minLength` or
// `maxLength` for strings (OpenAI's structured outputs guide, read 2026-10-12): a text limit
// goes in `description`. What passes a limit anyway is fixed by `normalize`, never refused here.
const GENERATED_BOUNDS = new Set(["$schema", "minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum"]);

function withoutBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutBounds);
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node as Record<string, unknown>)
      .filter(([key]) => !GENERATED_BOUNDS.has(key))
      .map(([key, value]) => [key, withoutBounds(value)] as const),
  );
}

type Node = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON Schema tree

const NAME_LIMIT = "At most 120 characters: shorten it on a word and keep the plan's whole line in the note.";

// `context` comes first: the answer is written in key order, so the moment `goals` opens is the
// moment the model has finished finding.
function buildSchema(): Node {
  const schema = withoutBounds(rawDraftJsonSchema) as Node;
  const goals = schema.properties.goals;
  goals.maxItems = 40;
  goals.description = "At most 40 goals in all, at most three levels deep.";
  const goal = goals.items.properties;
  const task = goal.tasks.items.properties;
  const child = task.children.items.properties;

  goal.name.description = NAME_LIMIT;
  goal.parent.description = "The key of the goal this one sits inside, or null. At most three levels: a goal inside a goal inside a goal.";
  goal.measure.description = "What the plan counts in. Hours when the plan counts hours.";
  task.name.description = NAME_LIMIT;
  child.name.description = NAME_LIMIT;
  task.estimate.description = "Hours only on a task with no sub-tasks; null on a task that has sub-tasks. In the plan's own unit.";
  child.estimate.description = "In the plan's own unit; null when the plan gives none.";

  const cadence = goal.commitments.items.properties.cadenceN;
  const integer = cadence.anyOf.find((branch: Node) => branch.type === "integer");
  integer.minimum = 1;
  integer.maximum = 365;
  cadence.description = "times_per_week: 1 to 7. times_per_month: 1 to 31. every_n_days: 1 to 365. null for the other cadences.";
  goal.commitments.items.properties.cadenceWeekdays.description = "weekdays only: the days it asks, 1 = Monday to 7 = Sunday. null for the other cadences.";

  const rule = goal.rules.items.properties;
  rule.id.description = "A short key of your choosing; each task the rule governs names it in its \"rule\".";
  rule.perWeek.description = "What the rule asks each week, in the plan's own unit.";
  task.week.description = "The week the plan lists the task under, as the plan names it; every task of one week carries the same text. null when the plan lists no weeks.";
  task.rule.description = "The \"id\" of the goal's rule that governs this task, or null.";
  child.rule.description = "The \"id\" of the rule that governs this sub-task, or null to take its task's.";

  return {
    ...schema,
    properties: {
      context: {
        type: "array",
        description: "What the plan is not: a diagnosis, costs, sources, a reading list, with the lines each spans.",
        items: {
          type: "object",
          properties: {
            what: { type: "string" },
            src: goal.src,
          },
          required: ["what", "src"],
          additionalProperties: false,
        },
      },
      goals: schema.properties.goals,
    },
    required: ["context", "goals"],
  };
}

export const rawDraftStrictSchema = buildSchema();

const TEXT_EXTENSIONS = [".txt", ".md", ".markdown", ".csv", ".json"];
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const WORKBOOK_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type FileRoute = "text" | "pdf" | "image" | "workbook" | null;

// Chat completions takes a PDF as a file part and nothing else of a document:
// a .docx is refused here rather than sent to be rejected.
export function fileRoute(name: string, type: string): FileRoute {
  const mime = type.toLowerCase().split(";")[0].trim();
  const lower = name.toLowerCase();
  if (mime === WORKBOOK_TYPE || lower.endsWith(".xlsx")) return "workbook";
  if (mime === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (IMAGE_TYPES.includes(mime)) return "image";
  if (mime.startsWith("text/") || mime === "application/json" || TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return "text";
  }
  return null;
}

export const PDF_PAGES_MAX = 40;
export const IMAGE_PIXELS_MAX = 40_000_000;

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");

// Pages by the page objects and by the largest `/Count` of the page tree: a PDF 1.5 hides objects in
// compressed streams but keeps the tree's count in the clear far more often than not.
export function pdfPages(bytes: Uint8Array): number {
  const text = latin1(bytes);
  const objects = (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
  let counted = 0;
  for (const m of text.matchAll(/\/Count\s+(\d+)/g)) counted = Math.max(counted, Number(m[1]));
  return Math.max(objects, counted);
}

// Width and height from the header of a PNG, GIF or JPEG; null when the file shows none.
export function imagePixels(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47) return view.getUint32(16) * view.getUint32(20);
  if (bytes.length >= 10 && latin1(bytes.subarray(0, 3)) === "GIF") return view.getUint16(6, true) * view.getUint16(8, true);
  if (bytes.length >= 4 && view.getUint16(0) === 0xffd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return view.getUint16(at + 5) * view.getUint16(at + 7);
      }
      at += 2 + view.getUint16(at + 2);
    }
  }
  return null;
}

const MAGIC: Record<"pdf" | "image", (b: Uint8Array) => boolean> = {
  pdf: (b) => latin1(b.subarray(0, 1024)).includes("%PDF-"),
  image: (b) =>
    (b[0] === 0x89 && b[1] === 0x50) ||
    (b[0] === 0xff && b[1] === 0xd8) ||
    latin1(b.subarray(0, 3)) === "GIF" ||
    (latin1(b.subarray(0, 4)) === "RIFF" && latin1(b.subarray(8, 12)) === "WEBP"),
};

/**
 * Whether a PDF or an image is refused before any claim or model call: its bytes are not what its
 * name says, or it has more pages or pixels than one read is worth. Text and workbooks pass.
 */
export function fileRefused(route: FileRoute, bytes: Uint8Array): boolean {
  if (route !== "pdf" && route !== "image") return false;
  if (!MAGIC[route](bytes)) return true;
  if (route === "pdf") return pdfPages(bytes) > PDF_PAGES_MAX;
  return (imagePixels(bytes) ?? 0) > IMAGE_PIXELS_MAX;
}

type ReadableRoute = "text" | "pdf" | "image";

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

function planText(input: PlanInput, route: ReadableRoute): string | null {
  if (input.kind === "text") return input.text;
  return route === "text" ? new TextDecoder().decode(input.bytes) : null;
}

function sourceOf(text: string | null): Source {
  return text === null ? { kind: "parts", lines: null } : { kind: "lines", lines: splitLines(text) };
}

function userContent(input: PlanInput, route: ReadableRoute, text: string | null): unknown[] {
  if (text !== null) return [{ type: "text", text: numberLines(text) }];
  const file = input as Extract<PlanInput, { kind: "file" }>;
  const mime = route === "pdf" ? "application/pdf" : file.type.toLowerCase().split(";")[0].trim();
  const dataUrl = `data:${mime};base64,${toBase64(file.bytes)}`;
  if (route === "pdf") return [{ type: "file", file: { filename: file.name, file_data: dataUrl } }];
  return [{ type: "image_url", image_url: { url: dataUrl } }];
}

// Types, not limits: `rawDraftSchema` has none, so a name of 150 or nine times a week passes
// and `normalize` fixes it. `context` is the model's scratch for the first step and is dropped.
function judge(content: unknown, usage: Usage | undefined, source: Source): PlanReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof content === "string" ? content : "");
  } catch {
    return { status: "failed", usage };
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const { context: _context, ...rest } = parsed as Record<string, unknown>;
    void _context;
    parsed = rest;
  }
  const goals = (parsed as { goals?: unknown } | null)?.goals;
  if (Array.isArray(goals) && goals.length === 0) return { status: "empty", usage };
  const result = rawDraftSchema.safeParse(parsed);
  if (!result.success) return { status: "invalid", usage };
  return { status: "ok", raw: result.data, source, usage: usage ?? { input: 0, output: 0 } };
}

// Tells when the answer being written opens the top-level key `goals`, however the pieces
// split it, and never on the word inside a string value.
function goalsWatch() {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let text = "";
  let candidate: string | null = null;
  return (piece: string): boolean => {
    for (const char of piece) {
      if (inString) {
        if (escaped) {
          escaped = false;
          text += char;
        } else if (char === "\\") escaped = true;
        else if (char === '"') {
          inString = false;
          candidate = depth === 1 ? text : null;
        } else text += char;
        continue;
      }
      if (char === '"') {
        inString = true;
        text = "";
      } else if (char === ":") {
        if (candidate === "goals") return true;
        candidate = null;
      } else if (char === "{" || char === "[") {
        depth += 1;
        candidate = null;
      } else if (char === "}" || char === "]") {
        depth -= 1;
        candidate = null;
      } else if (!/\s/.test(char)) candidate = null;
    }
    return false;
  };
}

type Chunk = {
  choices?: Array<{ delta?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
};

// Reads the server-sent events of a streamed completion into the whole answer.
async function readStream(
  body: ReadableStream<Uint8Array>,
  onStep: (step: Step) => void,
): Promise<{ content: string; finish: string | null; refusal: boolean; usage: Usage | undefined }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const watch = goalsWatch();
  let content = "";
  let finish: string | null = null;
  let refusal = false;
  let usage: Usage | undefined;
  let arranged = false;
  let buffer = "";

  const take = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") return;
    const chunk = JSON.parse(data) as Chunk;
    if (chunk.usage && (chunk.usage.prompt_tokens !== undefined || chunk.usage.completion_tokens !== undefined)) {
      usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.delta?.refusal) refusal = true;
    if (choice.finish_reason) finish = choice.finish_reason;
    const piece = choice.delta?.content;
    if (piece) {
      content += piece;
      if (!arranged && watch(piece)) {
        arranged = true;
        onStep("arrange");
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach(take);
  }
  buffer += decoder.decode();
  if (buffer !== "") take(buffer);
  return { content, finish, refusal, usage };
}

async function answerFromStub(stub: ModelStub, source: Source, onStep: (step: Step) => void): Promise<PlanReading> {
  if (stub.kind === "fail") return { status: "failed" };
  if (stub.kind === "empty") return { status: "empty" };
  if (stub.kind === "invalid") return { status: "invalid" };
  try {
    const content = await readFile(stub.path, "utf8");
    onStep("find");
    onStep("arrange");
    return judge(content, { input: 0, output: 0 }, source);
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
 * One streamed call: a pasted text or an uploaded file in, the model's raw draft out with the
 * source its lines came from. `onStep` hears «find» when the request leaves and «arrange» when
 * the answer opens `goals`. A PDF and an image go as parts, never parsed; a workbook is not the
 * model's. Never throws: every failure is a named status.
 */
export async function readPlan(input: PlanInput, onStep: (step: Step) => void): Promise<PlanReading> {
  const route = input.kind === "text" ? "text" : fileRoute(input.name, input.type);
  if (route === null || route === "workbook") return { status: "unreadableType" };
  if (input.kind === "text" && input.text.trim() === "") return { status: "empty" };

  const text = planText(input, route);
  const source = sourceOf(text);

  const stub = stubNow();
  if (stub) return answerFromStub(stub, source, onStep);

  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return { status: "failed" };

  const body = {
    model: MODEL_NAME,
    reasoning_effort: REASONING_EFFORT,
    max_completion_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
    stream_options: { include_usage: true },
    response_format: {
      type: "json_schema",
      json_schema: { name: "import_draft", schema: rawDraftStrictSchema, strict: true },
    },
    messages: [
      { role: "system", content: importSystemPrompt(todayInZone()) },
      { role: "user", content: userContent(input, route, text) },
    ],
  };

  try {
    onStep("find");
    const response = await fetch(CHAT_COMPLETIONS_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      console.error("import model read failed: status", response.status, await errorOf(response));
      return { status: "failed" };
    }

    const answer = await readStream(response.body, onStep);
    if (answer.finish === "length" || answer.refusal) return { status: "failed", usage: answer.usage };
    return judge(answer.content, answer.usage, source);
  } catch (error) {
    console.error("import model read failed:", error instanceof Error ? `${error.name}: ${error.message}` : "unknown");
    return { status: "failed" };
  }
}

// The provider's error type and code. Never its message: a rejected key is echoed there.
async function errorOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { type?: unknown; code?: unknown } };
    return [body.error?.type, body.error?.code].filter((part) => typeof part === "string").join(" ");
  } catch {
    return "";
  }
}
