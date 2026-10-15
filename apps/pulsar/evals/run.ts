import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { mock } from "node:test";

// The real model, graded by code. Run through `npm run evals`; it refuses without EVALS=1 and a key.

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (process.env.EVALS !== "1") {
  console.error("evals: refused. This spends money on the real model; set EVALS=1 to run it.");
  process.exit(2);
}
if (!apiKey) {
  console.error("evals: refused. OPENAI_API_KEY is not set (apps/pulsar/.env.local or the environment).");
  process.exit(2);
}

const K = Number(flag("k") ?? process.env.EVALS_K ?? 3);
const LIMIT = flag("limit") === undefined ? Infinity : Number(flag("limit"));
const ONLY = flag("only");
const CONCURRENCY = Number(flag("concurrency") ?? 4);
// USD per million tokens, in then out. The defaults are estimates, not a price list:
// set EVALS_PRICE_<IMPORT|CHAT>=in,out to the provider's current figures.
const MAX_USD = Number(process.env.EVALS_MAX_USD ?? 10);
const OUT_DIR = process.env.EVALS_OUT ?? "../../private/evals";

async function main() {
const fakeEnv = { OPENAI_API_KEY: apiKey, PULSAR_MODEL_STUB: undefined, PULSAR_CHAT_STUB: undefined };
mock.module("@/lib/env", { namedExports: { env: fakeEnv } });

// The catalogue pulls the acts and the queries, which need a session and a database: their reads
// are replaced below by the fixture plan, and a write never runs in the chat (RP-92).
const never = (name: string) => async () => {
  throw new Error(`${name} ran in an eval`);
};
const stub = (...names: string[]) => Object.fromEntries(names.map((name) => [name, never(name)]));
mock.module("@/app/actions/budgets", { namedExports: stub("setMonthBudget") });
mock.module("@/app/actions/facts", { namedExports: stub("declareFact") });
mock.module("@/app/actions/one-offs", { namedExports: stub("completeOneOff", "createOneOff", "fixTask", "scheduleOneOff", "setOneOffNote") });
mock.module("@/app/actions/plan", {
  namedExports: stub("addCommitment", "addPhase", "createGoal", "moveGoal", "moveHorizon", "renameGoal", "retireCommitment", "setGoalMeasure", "setGoalNote"),
});
mock.module("@/app/actions/roadmap", { namedExports: stub("setRhythm") });
mock.module("@/lib/mcp/shape", { namedExports: stub("shapeDay", "shapeGoal", "shapeGoalList", "shapeLoose", "shapeMonth", "shapeReport") });
mock.module("@/lib/plan/roadmap-read", { namedExports: stub("planMonthList") });
mock.module("@/lib/queries/day", { namedExports: stub("loadDay") });
mock.module("@/lib/queries/goal", { namedExports: stub("listGoalsForMetas", "listLooseCommitments", "loadGoal") });
mock.module("@/lib/queries/one-offs", { namedExports: stub("listDaylessOneOffs", "listScheduledOneOffs") });
mock.module("@/lib/queries/report", { namedExports: stub("loadReport") });
mock.module("@/lib/zone", { namedExports: { todayInZone: () => "2026-10-14", TIME_ZONE: "America/Bogota" } });

const { readPlan, MODEL_NAME } = await import("@/lib/import/model");
const { answerChat, CHAT_MODEL } = await import("@/lib/chat/model");
const { readTools } = await import("@/lib/tools/catalogue");
const { importCases } = await import("./import-cases");
const { chatCases } = await import("./chat-cases");
const { knownIds, reads: fixtureReads } = await import("./chat-fixture");
const { gradeChat, gradeImport } = await import("./grade");

const readLog = new AsyncLocalStorage<string[]>();
for (const spec of readTools) {
  spec.run = async (input) => {
    readLog.getStore()?.push(spec.name);
    return { ok: true, value: fixtureReads[spec.name](input) as Record<string, unknown> };
  };
}

type Price = [input: number, output: number];
function priceOf(kind: "IMPORT" | "CHAT", fallback: Price): Price {
  const given = process.env[`EVALS_PRICE_${kind}`]?.split(",").map(Number);
  return given && given.length === 2 && given.every(Number.isFinite) ? [given[0], given[1]] : fallback;
}
const PRICES = { import: priceOf("IMPORT", [1.25, 10]), chat: priceOf("CHAT", [0.25, 2]) };

type Job = { id: string; kind: "import" | "chat"; run: () => Promise<{ fails: string[]; usage?: { input: number; output: number }; transcript: unknown }> };

const jobs: Job[] = [
  ...importCases.map((c): Job => ({
    id: c.id,
    kind: "import",
    run: async () => {
      const reading = await readPlan({ kind: "text", text: c.text }, () => {});
      return { fails: gradeImport(reading, c.text, c.expect), usage: reading.usage, transcript: reading };
    },
  })),
  ...chatCases.map((c): Job => ({
    id: c.id,
    kind: "chat",
    run: async () => {
      const log: string[] = [];
      const answer = await readLog.run(log, () => answerChat(structuredClone(c.turns)));
      return { fails: gradeChat(answer, log, knownIds, c.expect), usage: answer.usage, transcript: { reads: log, answer } };
    },
  })),
];

// Round-robin across kinds, so a small --limit still touches both.
function interleave(list: Job[]): Job[] {
  const groups = [list.filter((j) => j.kind === "import"), list.filter((j) => j.kind === "chat")];
  const out: Job[] = [];
  for (let i = 0; groups.some((g) => i < g.length); i++) for (const g of groups) if (i < g.length) out.push(g[i]);
  return out;
}

const selected = interleave(jobs.filter((j) => !ONLY || j.id.startsWith(ONLY) || j.id === ONLY)).slice(0, LIMIT);

type Run = { fails: string[]; transcript: unknown };
const results = new Map<string, Run[]>(selected.map((j) => [j.id, []]));
const tokens = { import: { input: 0, output: 0 }, chat: { input: 0, output: 0 } };
const usd = () => (["import", "chat"] as const).reduce((sum, k) => sum + (tokens[k].input * PRICES[k][0] + tokens[k].output * PRICES[k][1]) / 1e6, 0);

const started = Date.now();
const queue = selected.flatMap((job) => Array.from({ length: K }, () => job));
let overBudget = false;

async function worker() {
  for (let job = queue.shift(); job; job = queue.shift()) {
    if (usd() >= MAX_USD) {
      overBudget = true;
      return;
    }
    let run: Run;
    try {
      const done = await job.run();
      if (done.usage) {
        tokens[job.kind].input += done.usage.input;
        tokens[job.kind].output += done.usage.output;
      }
      run = { fails: done.fails, transcript: done.transcript };
    } catch (error) {
      run = { fails: [`threw ${error instanceof Error ? error.name : "error"}`], transcript: null };
    }
    results.get(job.id)!.push(run);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

let failedCases = 0;
console.log(`evals: ${selected.length} cases, k=${K}, import ${MODEL_NAME}, chat ${CHAT_MODEL}\n`);
for (const job of selected) {
  const runs = results.get(job.id)!;
  const passed = runs.filter((r) => r.fails.length === 0).length;
  const ok = runs.length === K && passed === K;
  if (!ok) failedCases += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${job.id.padEnd(34)} pass^${K} ${passed}/${runs.length}`);
  if (!ok) for (const reason of new Set(runs.flatMap((r) => r.fails.slice(0, 3)))) console.log(`        - ${reason}`);
}

const seconds = Math.round((Date.now() - started) / 1000);
const total = (k: "import" | "chat") => `${k} ${tokens[k].input} in / ${tokens[k].output} out`;
console.log(`\npass^${K}: ${selected.length - failedCases}/${selected.length} cases`);
console.log(`tokens: ${total("import")}; ${total("chat")}`);
console.log(`spend: ~$${usd().toFixed(2)} (estimated at EVALS_PRICE rates, import ${PRICES.import.join("/")}, chat ${PRICES.chat.join("/")} per 1M)`);
console.log(`duration: ${seconds}s${overBudget ? `; stopped at the $${MAX_USD} cap (EVALS_MAX_USD)` : ""}`);

mkdirSync(OUT_DIR, { recursive: true });
const file = `${OUT_DIR}/evals-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ k: K, tokens, usd: usd(), seconds, results: Object.fromEntries(results) }, null, 2));
console.log(`transcripts: ${file}`);
process.exit(failedCases > 0 || overBudget ? 1 : 0);
}

void main();
