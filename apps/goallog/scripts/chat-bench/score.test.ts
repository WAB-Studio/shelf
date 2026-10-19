import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { ceilingReached, CEILING_USD, costUnits, parseBenchArgs, parsePrice } from "./run";
import { percentile, resolveExpected, scoreAnswer } from "./score";
import { TASKS, type Expected } from "./tasks";

const ids = { "goal.english": "g-1", "task.maze": "t-1" };
const env = { OPENAI_API_KEY: "sk-fixture", PULSAR_CHAT_BENCH_MODEL: "gpt-x" };
const args = [
  "--i-pay", "--target", "http://localhost:3208", "--model", "gpt-x", "--price-in", "0.25", "--price-out", "2",
  "--sessions", "a.json", "--seed", "seed.json",
];

test("the guard refuses a run without --i-pay before any fetch", () => {
  const fetched: unknown[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((...call: unknown[]) => (fetched.push(call), real(call[0] as string))) as typeof fetch;
  try {
    assert.throws(() => parseBenchArgs(args.filter((arg) => arg !== "--i-pay"), env), /--i-pay/);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(fetched.length, 0);
});

test("the guard refuses a missing key, a remote target and a model that differs", () => {
  assert.throws(() => parseBenchArgs(args, { PULSAR_CHAT_BENCH_MODEL: "gpt-x" }), /OPENAI_API_KEY/);
  const remote = args.map((arg) => (arg === "http://localhost:3208" ? "https://goallogapp.vercel.app" : arg));
  assert.throws(() => parseBenchArgs(remote, env), /localhost/);
  assert.throws(() => parseBenchArgs(args, { ...env, PULSAR_CHAT_BENCH_MODEL: "other" }), /PULSAR_CHAT_BENCH_MODEL/);
  assert.equal(parseBenchArgs(args, env).target, "http://localhost:3208");
});

test("the guard refuses an estimate that reaches the ceiling", () => {
  const dear = args.map((arg) => (arg === "2" ? "400" : arg));
  assert.throws(() => parseBenchArgs(dear, env), /ceiling/);
});

test("the ceiling stops at USD 10 and above, not under", () => {
  const prices = { inMicro: parsePrice("1", "x"), outMicro: parsePrice("1", "x") };
  assert.equal(CEILING_USD, 10);
  assert.equal(ceilingReached(5_000_000, 5_000_000, prices), true);
  assert.equal(ceilingReached(5_000_000, 5_000_001, prices), true);
  assert.equal(ceilingReached(5_000_000, 4_999_999, prices), false);
  assert.equal(costUnits(1_000_000, 0, prices), 1e12);
});

test("the scorer passes the right tool with the right arguments", () => {
  const expected = resolveExpected(
    { kind: "proposal", changes: [{ tool: "fix_task", args: { one_off_id: "$task.maze", month: "2026-11" } }] },
    ids,
  );
  const right = { reply: "", changes: [{ tool: "fix_task", input: { one_off_id: "t-1", month: "2026-11" } }] };
  assert.equal(scoreAnswer(expected, right).pass, true);
});

test("the scorer fails the right tool on the wrong goal id, a wrong tool and an extra change", () => {
  const expected = resolveExpected(
    { kind: "proposal", changes: [{ tool: "rename_goal", args: { goal_id: "$goal.english", name: "English" } }] },
    ids,
  );
  const wrongId = { reply: "", changes: [{ tool: "rename_goal", input: { goal_id: "g-2", name: "English" } }] };
  assert.equal(scoreAnswer(expected, wrongId).pass, false);
  const wrongTool = { reply: "", changes: [{ tool: "set_goal_note", input: { goal_id: "g-1", name: "English" } }] };
  assert.equal(scoreAnswer(expected, wrongTool).pass, false);
  const extra = {
    reply: "",
    changes: [
      { tool: "rename_goal", input: { goal_id: "g-1", name: "English" } },
      { tool: "set_goal_note", input: { goal_id: "g-1", note: "x" } },
    ],
  };
  assert.equal(scoreAnswer(expected, extra).pass, false);
});

test("the scorer passes a refusal given and fails one broken", () => {
  assert.equal(scoreAnswer({ kind: "none" }, { reply: "No puedo borrar.", changes: [] }).pass, true);
  assert.equal(scoreAnswer({ kind: "none" }, { reply: "", changes: [] }).pass, false);
  const proposed = { reply: "Listo", changes: [{ tool: "complete_task", input: {} }] };
  assert.equal(scoreAnswer({ kind: "none" }, proposed).pass, false);
});

test("the scorer checks the facts of a reply and matches free text by inclusion", () => {
  assert.equal(scoreAnswer({ kind: "reply", facts: ["Maze"] }, { reply: "Tienes maze hoy", changes: [] }).pass, true);
  assert.equal(scoreAnswer({ kind: "reply", facts: ["Maze"] }, { reply: "Nada", changes: [] }).pass, false);
  const note: Expected = { kind: "proposal", changes: [{ tool: "set_task_note", args: { note: { includes: "portada" } } }] };
  assert.equal(scoreAnswer(note, { reply: "", changes: [{ tool: "set_task_note", input: { note: "con la Portada nueva" } }] }).pass, true);
});

test("a refused proposal never passes, and an unseeded key throws", () => {
  const expected: Expected = { kind: "proposal", changes: [{ tool: "complete_task", args: {} }] };
  assert.equal(scoreAnswer(expected, { reply: "", changes: [{ tool: "complete_task", input: {}, refused: "x" }] }).pass, false);
  assert.throws(() => resolveExpected({ kind: "proposal", changes: [{ tool: "a", args: { id: "$nope" } }] }, ids), /nope/);
});

test("percentile takes the nearest rank", () => {
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
});

test("there are 25 tasks with unique ids, and no package script runs the bench", () => {
  assert.equal(TASKS.length, 25);
  assert.equal(new Set(TASKS.map((task) => task.id)).size, 25);
  const scripts = (JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  assert.equal(Object.keys(scripts).filter((name) => /bench/.test(name)).length, 0);
  assert.equal(Object.values(scripts).some((line) => line.includes("chat-bench")), false);
});

test("CHAT.md lists every write tool and names the missing acts and Q4", () => {
  const source = readFileSync(resolve(process.cwd(), "lib/tools/catalogue.ts"), "utf8");
  const tools = [...source.matchAll(/^\s*write\(\s*"([a-z_]+)"/gm)].map((m) => m[1]!);
  assert.ok(tools.length >= 18);
  const doc = readFileSync(resolve(process.cwd(), "../../docs/goallog/CHAT.md"), "utf8");
  for (const tool of tools) assert.ok(doc.includes(`\`${tool}\``), tool);
  for (const word of ["editTask", "editPhase", "Q4"]) assert.ok(doc.includes(word), word);
});
