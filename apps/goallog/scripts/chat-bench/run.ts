// Measures one model on the 25 chat tasks through a lane's own `POST /chat/enviar` (docs/goallog/CHAT.md).
// It spends real money and nothing imports it: no package.json entry, no check, no CI job. The main
// session runs it with the user's yes, from apps/goallog, inside `scripts/supabase-local.sh exec`:
//   1. Mint two sessions on the lane's server:
//      HARNESS_LANE=8 PULSAR_BASE_URL=http://localhost:3206 npm run harness:mint-session   (and HARNESS_LANE=9)
//   2. Seed each person's plan and write the ids:
//      npx tsx --env-file=.env.local scripts/chat-bench/seed.ts \
//        --sessions private/session-8.json,private/session-9.json --out private/chat-bench-seed.json
//   3. Start the lane's server with the key and the model:
//      OPENAI_API_KEY=… PULSAR_CHAT_BENCH_MODEL=<model> PORT=3206 npm run dev
//   4. Run, with the same key and model:
//      OPENAI_API_KEY=… PULSAR_CHAT_BENCH_MODEL=<model> npx tsx --env-file=.env.local scripts/chat-bench/run.ts --i-pay \
//        --target http://localhost:3206 --model <model> --price-in 0.25 --price-out 2 \
//        --sessions private/session-8.json,private/session-9.json --seed private/chat-bench-seed.json
//    Add `--only s-schedule,s-complete` (ids from tasks.ts) to send just those tasks; an unknown id refuses before any request.
// Restart the server (step 3) for each model; the seed (steps 1-2) is built once.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { benchLine, percentile, resolveExpected, scoreAnswer, type Answer } from "./score";
import { TASKS, type BenchTask } from "./tasks";

// Prices are USD per million tokens, kept as micro-USD per million (0.25 -> 250000) so no cost is a float.
export type Prices = { inMicro: number; outMicro: number };

// A cost is tokens x micro-USD per million: units of 1e-12 USD.
const UNITS_PER_USD = 1e12;
export const CEILING_USD = 10;
export const MESSAGES_PER_PERSON = 40;

// The estimate of docs/goallog/CHAT.md: a message's rounds, tools and reads included.
export const EST_INPUT_TOKENS = 15_000;
export const EST_OUTPUT_TOKENS = 1_500;

export type BenchConfig = {
  target: string;
  model: string;
  prices: Prices;
  sessions: string[];
  seed: string;
  // Task ids to send; absent means every task.
  only?: string[];
};

// Throws on an id tasks.ts does not hold, naming it, so a typo costs nothing.
export function selectTasks(only?: string[]): readonly BenchTask[] {
  if (only === undefined) return TASKS;
  const known = new Set(TASKS.map((task) => task.id));
  for (const id of only) if (!known.has(id)) throw new Error(`--only names an unknown task id: ${id}`);
  const wanted = new Set(only);
  return TASKS.filter((task) => wanted.has(task.id));
}

export function estimateUnits(count: number, prices: Prices): number {
  return costUnits(count * EST_INPUT_TOKENS, count * EST_OUTPUT_TOKENS, prices);
}

export function parsePrice(raw: string | undefined, flag: string): number {
  const match = /^([0-9]+)(?:\.([0-9]{1,6}))?$/.exec(raw ?? "");
  if (!match) throw new Error(`${flag} is USD per million tokens, like 0.25`);
  return Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0"));
}

export function costUnits(tokensIn: number, tokensOut: number, prices: Prices): number {
  return tokensIn * prices.inMicro + tokensOut * prices.outMicro;
}

// At the ceiling is over it: the run stops when the count reaches USD 10, not when it passes it.
export function ceilingReached(tokensIn: number, tokensOut: number, prices: Prices, ceilingUsd = CEILING_USD): boolean {
  return costUnits(tokensIn, tokensOut, prices) >= ceilingUsd * UNITS_PER_USD;
}

export function formatUsd(units: number): string {
  const micro = Math.round(units / 1e6);
  return `${Math.floor(micro / 1e6)}.${String(micro % 1e6).padStart(6, "0")}`;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

// Every refusal happens here, before the first fetch.
export function parseBenchArgs(argv: string[], env: Record<string, string | undefined>): BenchConfig {
  if (!argv.includes("--i-pay")) throw new Error("this run spends money on OpenAI: pass --i-pay");
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");

  const raw = flagValue(argv, "--target");
  let url: URL | null = null;
  try {
    url = raw ? new URL(raw) : null;
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.port === "") {
    throw new Error("--target must be a lane's http://localhost:<port>");
  }

  const model = flagValue(argv, "--model");
  if (!model) throw new Error("--model names the model the server runs");
  if (env.PULSAR_CHAT_BENCH_MODEL !== model) {
    throw new Error("PULSAR_CHAT_BENCH_MODEL must be set to the same model as --model, on this command and on the server");
  }

  const prices = {
    inMicro: parsePrice(flagValue(argv, "--price-in"), "--price-in"),
    outMicro: parsePrice(flagValue(argv, "--price-out"), "--price-out"),
  };
  const sessions = (flagValue(argv, "--sessions") ?? "").split(",").filter(Boolean);
  const onlyRaw = flagValue(argv, "--only");
  const only = onlyRaw === undefined ? undefined : onlyRaw.split(",").map((id) => id.trim()).filter(Boolean);
  if (onlyRaw !== undefined && only!.length === 0) throw new Error("--only needs task ids, like s-schedule,s-complete");
  const selected = selectTasks(only);
  if (sessions.length * MESSAGES_PER_PERSON < selected.length) {
    throw new Error(`--sessions needs ${Math.ceil(selected.length / MESSAGES_PER_PERSON)} harness sessions at least`);
  }
  const seed = flagValue(argv, "--seed");
  if (!seed) throw new Error("--seed names the file of ids each session holds");

  const estimate = estimateUnits(selected.length, prices);
  if (estimate >= CEILING_USD * UNITS_PER_USD) {
    throw new Error(`the estimate, USD ${formatUsd(estimate)}, reaches the USD ${CEILING_USD} ceiling`);
  }
  return { target: url.origin, model, prices, sessions, seed, ...(only ? { only } : {}) };
}

function cookieHeader(file: string): string {
  const state = JSON.parse(readFileSync(resolve(file), "utf8")) as { cookies: { name: string; value: string }[] };
  return state.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}

// What the run reaches outside itself, so a test can stand in for the server, the database and the disk.
export type BenchIo = {
  seeds: Record<string, Record<string, string>>;
  cookie: (session: string) => string;
  usage: (since: Date) => Promise<{ input: number; output: number }>;
  outDir: string;
  fetch?: typeof fetch;
};

export type BenchResult = { file: string; stopped: boolean };

// Rejected calls spend the daily allowance too, so a 429 moves to the next session and, with none left, ends the run.
// The table and every line so far reach the file whatever ends it.
export async function runBench(config: BenchConfig, io: BenchIo): Promise<BenchResult> {
  const send = io.fetch ?? fetch;
  let tokensIn = 0;
  let tokensOut = 0;
  let passed = 0;
  let stopped = false;
  const latencies: number[] = [];
  const lines: string[] = [];
  const capped = new Set<string>();
  let lastFile = "";
  let current = "";
  try {
    for (const [index, task] of selectTasks(config.only).entries()) {
      current = task.id;
      if (ceilingReached(tokensIn + EST_INPUT_TOKENS, tokensOut + EST_OUTPUT_TOKENS, config.prices)) {
        lines.push(`stopped before ${task.id}: the ceiling`);
        break;
      }
      let response: Response | null = null;
      let session = "";
      let started = new Date();
      let t0 = 0;
      while (response === null) {
        const open = config.sessions.filter((candidate) => !capped.has(candidate));
        const next = open[index % open.length];
        if (next === undefined) {
          stopped = true;
          break;
        }
        session = next;
        started = new Date();
        t0 = performance.now();
        const attempt = await send(`${config.target}/chat/enviar`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: config.target, cookie: io.cookie(session) },
          body: JSON.stringify({ turns: [{ role: "person", text: task.message }] }),
        });
        if (attempt.status === 429) {
          capped.add(session);
          if (capped.size >= config.sessions.length) {
            lines.push(`stopped at ${task.id}: ${session} reached its daily cap`);
            stopped = true;
            break;
          }
          continue;
        }
        response = attempt;
      }
      if (response === null) break;
      latencies.push(Math.round(performance.now() - t0));

      const ids = io.seeds[session];
      if (!ids) throw new Error(`--seed holds no ids for ${session}`);

      // The route answers no usage; the call's own row holds it. Runs are sequential, so the newest row is this one's.
      const usage = await io.usage(started);
      tokensIn += usage.input;
      tokensOut += usage.output;

      const body = response.ok ? ((await response.json()) as Answer) : null;
      const verdict = body
        ? scoreAnswer(resolveExpected(task.expected, ids), body)
        : { pass: false, why: `HTTP ${response.status}` };
      if (verdict.pass) passed += 1;
      lines.push(benchLine(task, verdict, body));
    }
  } catch (error) {
    stopped = true;
    lines.push(`stopped at ${current}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    const asked = latencies.length;
    const table = [
      "| model | task pass rate | mean input tokens | mean output tokens | cost (USD) | p50 ms | p95 ms |",
      "|---|---|---|---|---|---|---|",
      `| ${config.model} | ${passed}/${asked} | ${Math.round(tokensIn / Math.max(asked, 1))} | ${Math.round(tokensOut / Math.max(asked, 1))} | ${formatUsd(costUnits(tokensIn, tokensOut, config.prices))} | ${percentile(latencies, 50)} | ${percentile(latencies, 95)} |`,
    ].join("\n");
    mkdirSync(io.outDir, { recursive: true });
    lastFile = resolve(io.outDir, `${config.model}-${Date.now()}.md`);
    writeFileSync(lastFile, `${table}\n\n${lines.join("\n")}\n`, "utf8");
    console.log(`${table}\n${lines.join("\n")}\nwritten to ${lastFile}`);
  }
  return { file: lastFile, stopped };
}

async function main(): Promise<void> {
  const config = parseBenchArgs(process.argv.slice(2), process.env);
  const count = selectTasks(config.only).length;
  const estimate = estimateUnits(count, config.prices);
  console.log(`${count} messages to ${config.model}: estimate USD ${formatUsd(estimate)}, ceiling USD ${CEILING_USD}`);

  const seeds = JSON.parse(readFileSync(resolve(config.seed), "utf8")) as Record<string, Record<string, string>>;
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const { stopped } = await runBench(config, {
      seeds,
      cookie: cookieHeader,
      usage: async (since) => {
        const [row] = await sql<{ input_tokens: number | null; output_tokens: number | null }[]>`
          select input_tokens, output_tokens from goals.model_calls
          where source = 'chat' and called_at >= ${since} order by called_at desc limit 1`;
        return { input: row?.input_tokens ?? 0, output: row?.output_tokens ?? 0 };
      },
      outDir: resolve(process.cwd(), "private/chat-bench"),
    });
    if (stopped) process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
