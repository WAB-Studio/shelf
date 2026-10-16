// `check:plan` in two passes. The files that write `goals.model_calls` read and then claim against its
// whole-day count (RP-126), so they run one at a time; every other file runs in parallel as `node --test`
// does by default. One bare node command, because `checks-run.ts` spawns it with no shell.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const SPEND = ["model-calls.ts", "chat-route.ts", "import-route.ts"];

const all = readdirSync("scripts/plan")
  .filter((file) => file.endsWith(".ts"))
  .map((file) => `scripts/plan/${file}`);
const spend = SPEND.map((file) => `scripts/plan/${file}`);
for (const file of spend) {
  if (!all.includes(file)) throw new Error(`plan-run: ${file} is gone`);
}

const passes = [
  ["--test", "--test-concurrency=1", ...spend],
  ["--test", ...all.filter((file) => !spend.includes(file))],
];

let failed = false;
for (const args of passes) {
  const { status } = spawnSync(process.execPath, ["--import", "tsx", ...args], {
    env: process.env,
    stdio: "inherit",
  });
  if (status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
