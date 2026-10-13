import { z } from "zod";

// No `server-only` import: the unit suite cannot load it (as `model.ts`).
import { env } from "@/lib/env";

import type { Correction, ImportDraft } from "./draft";
import { MODEL_NAME, type Usage } from "./model";
import { modelStub } from "./model-seam";

// 903c: the second, short pass. The read puts the tasks of a plan where the plan wrote them, and a long
// plan writes them under its general goal. This asks which goal below each one serves, in one call.

const CHAT_COMPLETIONS_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const MAX_OUTPUT_TOKENS = 8_000;
const REASONING_EFFORT = "low";
const REQUEST_TIMEOUT_MS = 120_000;

export type Move = { from: number; task: number; to: number };

export type ArrangeReading =
  | { status: "ok"; moves: Move[]; usage: Usage }
  | { status: "none" }
  | { status: "failed" | "invalid"; usage?: Usage };

const answerSchema = z.strictObject({
  moves: z.array(z.strictObject({ holder: z.string(), task: z.number().int(), to: z.string() })),
});

export const moveJsonSchema = {
  type: "object",
  properties: {
    moves: {
      type: "array",
      description: "Only the tasks that clearly belong to one goal below. A task that serves the whole holder is not listed.",
      items: {
        type: "object",
        properties: {
          holder: { type: "string", description: "The key of the goal that holds the task." },
          task: { type: "integer", description: "The task's number `i` under that holder." },
          to: { type: "string", description: "The key of the goal below the holder that the task serves." },
        },
        required: ["holder", "task", "to"],
        additionalProperties: false,
      },
    },
  },
  required: ["moves"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = [
  `You are given goals that hold other goals, with the tasks each one holds and the goals inside it. A plan often writes every task under its general goal.`,
  `For each task, decide whether one goal inside the holder is the one it serves, by its name and by what that goal holds.`,
  `List only the tasks that clearly belong to one of those goals; a task that serves the holder as a whole is not listed.`,
  `Invent nothing: name only keys and task numbers you were given. Answer JSON shaped exactly by the given schema.`,
].join(" ");

// The goals that hold goals and tasks both: the ones worth asking about.
function holdersOf(draft: ImportDraft): number[] {
  const held = new Set(draft.goals.flatMap((goal) => (goal.parent === null ? [] : [goal.parent])));
  return draft.goals.flatMap((goal, g) => (held.has(goal.key) && goal.tasks.length > 0 ? [g] : []));
}

function stubbed(): boolean {
  return modelStub(env.PULSAR_MODEL_STUB, process.env.VERCEL) !== null;
}

// Whether the pass runs at all: something to ask, a key, and no test seam standing in for the model.
export function arrangeWanted(draft: ImportDraft): boolean {
  return Boolean(env.OPENAI_API_KEY) && !stubbed() && holdersOf(draft).length > 0;
}

function indexOfKey(draft: ImportDraft): Map<string, number> {
  const first = new Map<string, number>();
  draft.goals.forEach((goal, g) => {
    if (!first.has(goal.key)) first.set(goal.key, g);
  });
  return first;
}

// The goals under `holder`, at any depth, as the keys they are named by.
function below(draft: ImportDraft, holder: number): number[] {
  const first = indexOfKey(draft);
  return draft.goals.flatMap((goal, g) => {
    let at = g;
    for (let hops = 0; hops < 4; hops++) {
      const parent = draft.goals[at].parent;
      const p = parent === null ? undefined : first.get(parent);
      if (p === undefined || p >= at) return [];
      if (p === holder) return [g];
      at = p;
    }
    return [];
  });
}

function requestBody(draft: ImportDraft, holders: number[]) {
  const content = {
    holders: holders.map((g) => ({
      key: draft.goals[g].key,
      name: draft.goals[g].name,
      tasks: draft.goals[g].tasks.map((task, i) => ({ i, name: task.name, month: task.month })),
      goals: below(draft, g).map((b) => ({
        key: draft.goals[b].key,
        parent: draft.goals[b].parent,
        name: draft.goals[b].name,
        commitments: draft.goals[b].commitments.map((commitment) => commitment.name),
      })),
    })),
  };
  return {
    model: MODEL_NAME,
    reasoning_effort: REASONING_EFFORT,
    max_completion_tokens: MAX_OUTPUT_TOKENS,
    response_format: { type: "json_schema", json_schema: { name: "task_moves", schema: moveJsonSchema, strict: true } },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(content) },
    ],
  };
}

type Completion = {
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
};

// The moves the answer proposes that the draft can hold, in the holder's and the task's order.
function validMoves(draft: ImportDraft, holders: number[], answer: z.infer<typeof answerSchema>): Move[] {
  const first = indexOfKey(draft);
  const targets = new Map(holders.map((g) => [g, new Set(below(draft, g))]));
  const taken = new Set<string>();
  const moves: Move[] = [];
  for (const entry of answer.moves) {
    const from = first.get(entry.holder);
    const to = first.get(entry.to);
    if (from === undefined || to === undefined || !targets.get(from)?.has(to)) continue;
    if (entry.task < 0 || entry.task >= draft.goals[from].tasks.length) continue;
    const key = `${from}.${entry.task}`;
    if (taken.has(key)) continue;
    taken.add(key);
    moves.push({ from, task: entry.task, to });
  }
  return moves.sort((a, b) => a.from - b.from || a.task - b.task);
}

/**
 * One short, non-streamed call (903c): the tasks of each goal that holds goals, and those goals, in; the
 * moves the model proposes out, kept only when the draft can hold them. Never throws: a failure is a named
 * status and the draft stays as the read left it.
 */
export async function proposeMoves(draft: ImportDraft): Promise<ArrangeReading> {
  const holders = holdersOf(draft);
  const apiKey = env.OPENAI_API_KEY;
  if (holders.length === 0 || !apiKey || stubbed()) return { status: "none" };
  try {
    const response = await fetch(CHAT_COMPLETIONS_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(requestBody(draft, holders)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("import arrange failed: status", response.status);
      return { status: "failed" };
    }
    const body = (await response.json()) as Completion;
    const usage: Usage | undefined =
      body.usage && (body.usage.prompt_tokens !== undefined || body.usage.completion_tokens !== undefined)
        ? { input: body.usage.prompt_tokens ?? 0, output: body.usage.completion_tokens ?? 0 }
        : undefined;
    const choice = body.choices?.[0];
    if (!choice || choice.finish_reason === "length" || choice.message?.refusal) return { status: "failed", usage };
    let parsed: unknown;
    try {
      parsed = JSON.parse(choice.message?.content ?? "");
    } catch {
      return { status: "failed", usage };
    }
    const answer = answerSchema.safeParse(parsed);
    if (!answer.success) return { status: "invalid", usage };
    return { status: "ok", moves: validMoves(draft, holders, answer.data), usage: usage ?? { input: 0, output: 0 } };
  } catch (error) {
    console.error("import arrange failed:", error instanceof Error ? `${error.name}: ${error.message}` : "unknown");
    return { status: "failed" };
  }
}

// One rejectable correction per moved task, at the task's place in the draft as read.
export function moveCorrections(draft: ImportDraft, moves: Move[]): Correction[] {
  return [...moves]
    .sort((a, b) => a.from - b.from || a.task - b.task)
    .map(({ from, task, to }) => {
      const at = `goals.${from}.tasks.${task}`;
      return {
        id: `${at}:taskMoved`,
        at,
        code: "taskMoved" as const,
        said: draft.goals[from].name,
        proposed: draft.goals[to].name,
        values: { to: draft.goals[to].key, name: draft.goals[from].tasks[task].name },
        declined: "keepsPlan" as const,
      };
    });
}
