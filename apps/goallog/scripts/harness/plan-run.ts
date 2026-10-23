// `check:plan` in two passes. The files that write `goals.model_calls` read and then claim against its
// whole-day count (RP-126), so they run one at a time; every other file runs in parallel as `node --test`
// does by default. One bare node command, because `checks-run.ts` spawns it with no shell.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import postgres from "postgres";

const lane = Number(process.env.HARNESS_LANE?.trim() || 1);
const remint = "corre `npm run harness:mint-session`.";

// The user id the lane's session cookie names, read off its access token; null when the file is no session.
function sessionUserId(): string | null {
  try {
    const state = JSON.parse(readFileSync(resolve(process.cwd(), `private/session-${lane}.json`), "utf8")) as {
      cookies: Array<{ name: string; value: string }>;
    };
    const value = state.cookies
      .filter((cookie) => cookie.name.includes("-auth-token"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((cookie) => cookie.value)
      .join("");
    const session = JSON.parse(Buffer.from(value.replace(/^base64-/, ""), "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(String(session.access_token).split(".")[1], "base64url").toString("utf8"));
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

// Every file reads the lane's session file: a session whose user a reset or a reap removed fails them all
// one by one, so it is refused once, before any of them runs.
async function refuseDeadSession(): Promise<boolean> {
  const userId = sessionUserId();
  if (userId === null) {
    console.error(`No hay una sesión del carril ${lane}: ${remint}`);
    process.exit(1);
    return true;
  }
  const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1, connect_timeout: 5 });
  try {
    const rows = await db`select 1 from auth.users where id = ${userId}`;
    if (rows.length === 0) {
      console.error(`La sesión del carril ${lane} nombra un usuario que ya no existe: ${remint}`);
      process.exit(1);
      return true;
    }
  } finally {
    await db.end();
  }
  return false;
}

async function main(): Promise<void> {
  if (await refuseDeadSession()) return;
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
    const { status } = spawnSync(process.execPath, ["--import", "tsx", "--import", "./scripts/harness/end-app-pool.ts", ...args], {
      env: process.env,
      stdio: "inherit",
    });
    if (status !== 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

void main();
