// `check:day`, `check:goal`, `check:goal-actions` and `check:plan` under a run of their own.
// `e2e-run.ts`'s shape with another person: the run is opened here, mint and
// seed register under it, and `dropRun` takes the identity and closes it, so
// the checks never read a session another process minted and the order of
// this and `check:e2e` does not matter.
//
// Each check's command line is read from `package.json`, never repeated here.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { openRun } from "@repo/harness-registry";
import postgres from "postgres";

import { dropRun, runScript } from "./e2e-run";

const CHECKS = ["check:day", "check:goal", "check:goal-actions", "check:plan"] as const;

function argvOf(name: string): string[] {
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  // No shell runs these words, so a quoted glob keeps its quotes unless they
  // are cut here; `node --test` expands the glob itself.
  const words = (scripts[name]?.split(/\s+/) ?? []).map((word) => word.replace(/^"(.*)"$/, "$1"));
  if (words[0] !== "node") {
    throw new Error(`checks-run: package.json "${name}" is not a bare node command`);
  }
  return words.slice(1);
}

async function main(): Promise<number> {
  // Held open for the whole process: the heartbeat `openRun` starts writes
  // through this client.
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const runId = await openRun("queries", sql);
  process.env.HARNESS_RUN_ID = runId;
  console.log(`checks-run: opened run ${runId}`);

  let failed = false;
  try {
    runScript("scripts/harness/mint-session.ts", runId);
    runScript("scripts/harness/seed-goal.ts", runId);

    const lines: string[] = [];
    for (const name of CHECKS) {
      const started = Date.now();
      const { status } = spawnSync(process.execPath, argvOf(name), {
        env: process.env,
        stdio: "inherit",
      });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (status !== 0) failed = true;
      lines.push(`${status === 0 ? "PASS" : "FAIL"}  ${name}  exit ${status}  ${seconds}s`);
    }
    console.log(`\n${lines.join("\n")}`);
  } catch (error) {
    console.error(`checks-run: ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  } finally {
    try {
      await dropRun(sql);
    } catch (error) {
      console.error(`checks-run: ${error instanceof Error ? error.message : String(error)}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
