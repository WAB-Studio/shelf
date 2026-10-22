import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

import { ceilingReached, CEILING_USD, costUnits, parseBenchArgs, parsePrice, runBench, type BenchConfig } from "./run";
import { benchLine, percentile, resolveExpected, scoreAnswer } from "./score";
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

const first = TASKS[0]!;
const answer = { reply: "hola", changes: [{ tool: "add_task", input: { title: "x" } }] };

test("benchLine keeps the proposals and the reply of the answer", () => {
  const line = benchLine(first, { pass: false, why: "no proposal" }, answer);
  assert.match(line, /^FAIL .+: no proposal\n/);
  assert.ok(line.includes(JSON.stringify(answer.changes)));
  assert.ok(line.includes(JSON.stringify("hola")));
  assert.equal(benchLine(first, { pass: false, why: "HTTP 500" }, null).includes("\n"), false);
});

const config = (sessions: string[]): BenchConfig => ({
  target: "http://localhost:3208",
  model: "gpt-x",
  prices: { inMicro: 250000, outMicro: 2000000 },
  sessions,
  seed: "seed.json",
});
const io = (fetchStub: typeof fetch, calls: string[] = []) => ({
  seeds: { "a.json": {}, "b.json": {} },
  cookie: (session: string) => (calls.push(session), session),
  usage: async () => ({ input: 10, output: 1 }),
  outDir: mkdtempSync(resolve(tmpdir(), "bench-")),
  fetch: fetchStub,
});
const ok = () => new Response(JSON.stringify(answer), { status: 200 });
const cap = () => new Response("", { status: 429 });

test("a 429 on the second request writes the first answer and the stop line", async () => {
  let n = 0;
  const rig = io((async () => (++n === 1 ? ok() : cap())) as typeof fetch);
  const result = await runBench(config(["a.json"]), rig);
  const text = readFileSync(result.file, "utf8");
  assert.equal(result.stopped, true);
  assert.ok(text.includes(JSON.stringify(answer.changes)));
  assert.ok(text.includes(`stopped at ${TASKS[1]!.id}: a.json reached its daily cap`));
});

test("a 429 moves the task to the next session", async () => {
  const used: string[] = [];
  let n = 0;
  const rig = io((async () => (++n === 1 ? cap() : n > 3 ? cap() : ok())) as typeof fetch, used);
  const result = await runBench(config(["a.json", "b.json"]), rig);
  assert.deepEqual(used.slice(0, 2), ["a.json", "b.json"]);
  const text = readFileSync(result.file, "utf8");
  assert.ok(text.includes(JSON.stringify(answer.changes)));
  assert.ok(text.includes("reached its daily cap"));
});

test("any other thrown error still writes the file", async () => {
  const rig = io((async () => {
    throw new Error("socket closed");
  }) as typeof fetch);
  await assert.rejects(runBench(config(["a.json"]), rig), /socket closed/);
  const { readdirSync } = await import("node:fs");
  const [file] = readdirSync(rig.outDir);
  assert.ok(file);
  assert.ok(readFileSync(resolve(rig.outDir, file), "utf8").includes("stopped at"));
});
