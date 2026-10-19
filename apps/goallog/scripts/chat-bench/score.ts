// Pure: scores what `POST /chat/enviar` answered against what a task expected. No network, no clock.
import type { Arg, Expected } from "./tasks";

export type Answer = {
  reply: string;
  changes: { tool: string; input: Record<string, unknown>; refused?: string }[];
};

export type Verdict = { pass: boolean; why: string };

const SYMBOL = /^\$(.+)$/;

// Swaps each "$key" for the id the seeded person holds; a key with none is a bench error, never a pass.
export function resolveExpected(expected: Expected, ids: Record<string, string>): Expected {
  if (expected.kind !== "proposal") return expected;
  return {
    kind: "proposal",
    changes: expected.changes.map((change) => ({
      tool: change.tool,
      args: Object.fromEntries(
        Object.entries(change.args).map(([name, arg]) => {
          if (typeof arg !== "string") return [name, arg];
          const key = SYMBOL.exec(arg)?.[1];
          if (key === undefined) return [name, arg];
          const id = ids[key];
          if (id === undefined) throw new Error(`the seed holds no id for ${key}`);
          return [name, id];
        }),
      ),
    })),
  };
}

function argMatches(want: Arg, got: unknown): boolean {
  if (typeof want === "object" && want !== null) {
    return typeof got === "string" && got.toLowerCase().includes(want.includes.toLowerCase());
  }
  return want === got;
}

function changeMatches(want: { tool: string; args: Record<string, Arg> }, got: Answer["changes"][number]): boolean {
  return (
    want.tool === got.tool &&
    got.refused === undefined &&
    Object.entries(want.args).every(([name, arg]) => argMatches(arg, got.input[name]))
  );
}

export function scoreAnswer(expected: Expected, answer: Answer): Verdict {
  if (expected.kind === "none") {
    if (answer.changes.length > 0) return { pass: false, why: `proposed ${answer.changes.map((c) => c.tool).join(", ")}` };
    return answer.reply.trim() === "" ? { pass: false, why: "no reply" } : { pass: true, why: "" };
  }
  if (expected.kind === "reply") {
    if (answer.changes.length > 0) return { pass: false, why: "proposed a change to a question" };
    const reply = answer.reply.toLowerCase();
    const missing = expected.facts.filter((fact) => !reply.includes(fact.toLowerCase()));
    return missing.length === 0 ? { pass: true, why: "" } : { pass: false, why: `reply lacks ${missing.join(", ")}` };
  }
  if (answer.changes.length !== expected.changes.length) {
    return { pass: false, why: `expected ${expected.changes.length} changes, got ${answer.changes.length}` };
  }
  // Each expected change claims one proposal, so two alike cannot both ride on one.
  const free = [...answer.changes];
  for (const want of expected.changes) {
    const at = free.findIndex((got) => changeMatches(want, got));
    if (at === -1) return { pass: false, why: `no proposal matches ${want.tool}` };
    free.splice(at, 1);
  }
  return { pass: true, why: "" };
}

// Nearest-rank percentile of a non-empty list.
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}
