import { readFile } from "node:fs/promises";

// No `server-only` import: the unit suite cannot load it. The key is a server
// variable of `@/lib/env`, which refuses to read it in a client bundle.
import { z } from "zod";

import { env } from "@/lib/env";
import { readTools, writeTools, type ToolSpec } from "@/lib/tools/catalogue";

import { chatSystemPrompt } from "./prompt";
import { todayInZone } from "@/lib/zone";
import { chatStub, type ChatStub } from "./seam";
import { CHAT_TURNS_SENT, type Change, type ChatTurn } from "./types";

export const CHAT_MODEL = "gpt-5-mini";

const CHAT_COMPLETIONS_ENDPOINT = "https://api.openai.com/v1/chat/completions";

const MAX_ROUNDS = 5;

// Unmeasured: reasoning counts against it. The orchestrator's paid run (Unresolved of the chat plan) replaces both.
const MAX_OUTPUT_TOKENS = 4_000;
const REASONING_EFFORT = "low";
const REQUEST_TIMEOUT_MS = 60_000;

export type Usage = { input: number; output: number };

export type ChatAnswer =
  | { status: "ok"; reply: string; changes: Change[]; usage: Usage }
  | { status: "failed" | "invalid" | "empty"; usage?: Usage };

type ToolCall = { id: string; name: string; arguments: unknown };
type Round = { content: string | null; calls: ToolCall[]; usage: Usage };
type Message = Record<string, unknown>;

const catalogue: readonly ToolSpec[] = [...readTools, ...writeTools];

function stubNow(): ChatStub | null {
  return chatStub(env.PULSAR_CHAT_STUB, process.env.VERCEL);
}

export function chatAvailable(): boolean {
  return Boolean(env.OPENAI_API_KEY) || stubNow() !== null;
}

function toolsOffered() {
  return catalogue.map((spec) => ({
    type: "function",
    function: {
      name: spec.name,
      description: spec.description,
      parameters: z.toJSONSchema(spec.input),
    },
  }));
}

function messagesOf(turns: ChatTurn[]): Message[] {
  return [
    { role: "system", content: chatSystemPrompt(todayInZone()) },
    ...turns.slice(-CHAT_TURNS_SENT).map((turn) => ({
      role: turn.role === "person" ? "user" : "assistant",
      content: turn.text,
    })),
  ];
}

function errorMessage(id: string, error: string): Message {
  return { role: "tool", tool_call_id: id, content: JSON.stringify({ error }) };
}

function argumentsOf(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// A read runs; a write is parsed and kept as a change for the person to approve, never run (RP-92).
async function answerCall(call: ToolCall, changes: Change[]): Promise<Message> {
  const spec = catalogue.find((candidate) => candidate.name === call.name);
  if (!spec) return errorMessage(call.id, "unknown tool");
  const args = argumentsOf(call.arguments);
  if (args === null) return errorMessage(call.id, "arguments are not a JSON object");
  const parsed = spec.input.safeParse(args);
  if (!parsed.success) return errorMessage(call.id, z.prettifyError(parsed.error));
  if (spec.kind === "write") {
    changes.push({ id: crypto.randomUUID(), tool: spec.name, input: parsed.data as Record<string, unknown> });
    return { role: "tool", tool_call_id: call.id, content: JSON.stringify({ proposed: "propuesto, espera a la persona" }) };
  }
  const outcome = await spec.run(parsed.data as Record<string, unknown>);
  return {
    role: "tool",
    tool_call_id: call.id,
    content: JSON.stringify(outcome.ok ? outcome.value : { error: outcome.error }),
  };
}

type Source = (messages: Message[]) => Promise<Round | null>;

// The loop is the same for the model and the stub: only where a round comes from differs.
async function converse(source: Source, base: Message[]): Promise<ChatAnswer> {
  const messages = base;
  const changes: Change[] = [];
  const usage: Usage = { input: 0, output: 0 };
  const spent = () => (usage.input || usage.output ? { usage } : {});

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const got = await source(messages);
    if (got === null) return { status: "failed", ...spent() };
    usage.input += got.usage.input;
    usage.output += got.usage.output;

    if (got.calls.length === 0) {
      const reply = (got.content ?? "").trim();
      if (reply === "" && changes.length === 0) return { status: "empty", ...spent() };
      return { status: "ok", reply, changes, usage };
    }

    messages.push({
      role: "assistant",
      content: got.content,
      tool_calls: got.calls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
        },
      })),
    });
    for (const call of got.calls) messages.push(await answerCall(call, changes));
  }
  return { status: "failed", ...spent() };
}

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) }))
            .nullish(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).nullish(),
});

function modelSource(apiKey: string): Source {
  const tools = toolsOffered();
  return async (messages) => {
    const response = await fetch(CHAT_COMPLETIONS_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: CHAT_MODEL,
        reasoning_effort: REASONING_EFFORT,
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        messages,
        tools,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = completionSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    const message = parsed.data.choices[0].message;
    return {
      content: message.content ?? null,
      calls: (message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      usage: {
        input: parsed.data.usage?.prompt_tokens ?? 0,
        output: parsed.data.usage?.completion_tokens ?? 0,
      },
    };
  };
}

type ScriptEntry = { fail: true } | { reply: string; calls?: { name: string; arguments: unknown }[] };

type Found = { goals: { id: string; name: string }[]; tasks: { id: string; name: string }[]; commitments: { id: string; name: string }[] };

// The placeholders resolve through the catalogue's own reads, so a stub names what the plan really holds.
async function found(): Promise<Found> {
  const out: Found = { goals: [], tasks: [], commitments: [] };
  const run = async (name: string, input: Record<string, unknown> = {}) => {
    const outcome = await catalogue.find((spec) => spec.name === name)!.run(input);
    return outcome.ok ? outcome.value : {};
  };
  const list = (await run("list_goals")) as Record<string, { id: string; name: string }[] | undefined>;
  // A habit with no goal answers to its name too.
  out.commitments.push(...(list.looseHabits ?? []).map((habit) => ({ id: habit.id, name: habit.name })));
  for (const goal of [...(list.open ?? []), ...(list.ended ?? [])]) {
    out.goals.push({ id: goal.id, name: goal.name });
    const view = (await run("get_goal", { goal_id: goal.id })) as {
      tasks?: { id: string; name: string; children?: unknown[] }[];
      commitments?: { id: string; name: string }[];
    };
    const walk = (nodes: { id: string; name: string; children?: unknown[] }[]) => {
      for (const node of nodes) {
        out.tasks.push({ id: node.id, name: node.name });
        walk((node.children ?? []) as typeof nodes);
      }
    };
    walk(view.tasks ?? []);
    out.commitments.push(...(view.commitments ?? []).map((commitment) => ({ id: commitment.id, name: commitment.name })));
  }
  const loose = (await run("list_loose_one_offs")) as Record<string, { id: string; name: string }[] | undefined>;
  out.tasks.push(...[...(loose.dayless ?? []), ...(loose.scheduled ?? [])].map((task) => ({ id: task.id, name: task.name })));
  return out;
}

const PLACEHOLDER = /^\{\{(goal|task|commitment):(.+)\}\}$/;

function resolve(value: unknown, known: Found): unknown {
  if (typeof value === "string") {
    const match = PLACEHOLDER.exec(value);
    if (!match) return value;
    const pool = match[1] === "goal" ? known.goals : match[1] === "task" ? known.tasks : known.commitments;
    const hit = pool.find((item) => item.name === match[2]);
    if (!hit) throw new Error(`the stub names ${value} and the plan has none`);
    return hit.id;
  }
  if (Array.isArray(value)) return value.map((item) => resolve(item, known));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, known)]));
  }
  return value;
}

async function scriptSource(path: string, turns: ChatTurn[]): Promise<Source> {
  const last = turns[turns.length - 1];
  const script = JSON.parse(await readFile(path, "utf8")) as Record<string, ScriptEntry>;
  const entry = last?.role === "person" ? script[last.text.trim()] : undefined;
  if (!entry || "fail" in entry) return async () => null;
  const known = await found();
  const calls = (entry.calls ?? []).map((call, index) => ({
    id: `stub-${index}`,
    name: call.name,
    arguments: resolve(call.arguments, known),
  }));
  let served = false;
  return async () => {
    const wasServed = served;
    served = true;
    return wasServed || calls.length === 0
      ? { content: entry.reply, calls: [], usage: { input: 0, output: 0 } }
      : { content: null, calls, usage: { input: 0, output: 0 } };
  };
}

/**
 * One conversation in, the model's reply and the changes it proposes out. Reads
 * run; a write call comes back as a change and its act is never called (RP-92).
 * Never throws: every failure is a named status.
 */
export async function answerChat(turns: ChatTurn[]): Promise<ChatAnswer> {
  try {
    const stub = stubNow();
    if (stub?.kind === "fail") return { status: "failed" };
    if (stub) return await converse(await scriptSource(stub.path, turns), messagesOf(turns));

    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) return { status: "failed" };
    return await converse(modelSource(apiKey), messagesOf(turns));
  } catch {
    return { status: "failed" };
  }
}
