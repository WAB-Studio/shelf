import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { mock } from "node:test";

// `checks-run.ts` runs `main()` at import and ends in `process.exit`. The
// doors it reaches through are replaced: the database, the run registry, the
// minting scripts and the four child processes. What the test drives is the
// verdict the script owes its caller: any red check, exit 1.
let statuses: Array<number | null> = [];
let spawned = 0;
let argvs: string[][] = [];
let dropFails = false;
// What the plan-run preflight finds: the session file's text (null: no file) and whether `auth.users` has its user.
let sessionFile: string | null = null;
let userExists = true;

mock.module("node:child_process", {
  namedExports: {
    spawnSync: (_node: string, argv: string[]) => {
      argvs.push(argv);
      return { status: statuses[spawned++] };
    },
  },
});
mock.module("node:fs", {
  namedExports: {
    readdirSync: () => ["model-calls.ts", "chat-route.ts", "import-route.ts", "other.ts"],
    readFileSync: (path: string) => {
      if (String(path).includes("session-")) {
        if (sessionFile === null) throw new Error("ENOENT");
        return sessionFile;
      }
      return JSON.stringify({
        scripts: {
          "check:day": "node a.ts",
          "check:goal": "node b.ts",
          "check:goal-actions": "node c.ts",
          "check:plan": 'node --test "scripts/plan/*.ts"',
        },
      });
    },
  },
});
mock.module("@repo/harness-registry", {
  namedExports: { openRun: async () => "run-1" },
});
// plan-run is loaded as CommonJS and resolves postgres to its `cjs` entry, not the `import` one.
mock.module(createRequire(import.meta.url).resolve("postgres"), {
  defaultExport: () => Object.assign(async () => (userExists ? [{ "?column?": 1 }] : []), { end: async () => {} }),
});
mock.module("./e2e-run", {
  namedExports: {
    runScript: () => {},
    dropRun: async () => {
      if (dropFails) throw new Error("drop failed");
    },
  },
});

let n = 0;
async function exitCodeFor(checks: Array<number | null>, drop = false): Promise<number> {
  statuses = checks;
  spawned = 0;
  argvs = [];
  dropFails = drop;
  process.env.MIGRATION_DATABASE_URL = "postgres://unused";
  const exit = mock.method(process, "exit", () => undefined as never);
  const log = mock.method(console, "log", () => {});
  const err = mock.method(console, "error", () => {});
  try {
    const done = new Promise<number>((resolve) => {
      exit.mock.mockImplementation(((code: number) => resolve(code)) as never);
    });
    await import(`./checks-run?case=${n++}`);
    return await done;
  } finally {
    exit.mock.restore();
    log.mock.restore();
    err.mock.restore();
  }
}

test("four green checks exit 0, and all four ran", async () => {
  assert.equal(await exitCodeFor([0, 0, 0, 0]), 0);
  assert.equal(spawned, 4);
});

test("a quoted glob reaches node unquoted: no shell is there to strip it", async () => {
  await exitCodeFor([0, 0, 0, 0]);
  assert.deepEqual(argvs[3], ["--test", "scripts/plan/*.ts"]);
});

test("a red check exits 1 wherever it stands, and the rest still run", async () => {
  for (const red of [0, 1, 2, 3]) {
    const statuses = [0, 0, 0, 0];
    statuses[red] = 1;
    assert.equal(await exitCodeFor(statuses), 1, `check ${red} red`);
    assert.equal(spawned, 4);
  }
});

test("a check killed by a signal (no status) is red", async () => {
  assert.equal(await exitCodeFor([0, null, 0, 0]), 1);
});

test("a run that cannot be dropped exits 1 even when every check passed", async () => {
  assert.equal(await exitCodeFor([0, 0, 0, 0], true), 1);
});

// plan-run: the files it spawns all read `private/session-<lane>.json`; a session naming a user that is gone
// is refused once, before any of them runs.
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const sessionNaming = (sub: string) =>
  JSON.stringify({ cookies: [{ name: "sb-x-auth-token", value: `base64-${b64({ access_token: `h.${b64({ sub })}.s` })}` }] });

async function planRun(): Promise<{ code: number; stderr: string }> {
  spawned = 0;
  statuses = [0, 0];
  process.env.MIGRATION_DATABASE_URL = "postgres://unused";
  process.env.HARNESS_LANE = "2";
  let stderr = "";
  const err = mock.method(console, "error", (...parts: unknown[]) => {
    stderr += parts.join(" ");
  });
  const exit = mock.method(process, "exit", () => undefined as never);
  try {
    const done = new Promise<number>((resolve) => {
      exit.mock.mockImplementation(((code: number) => resolve(code)) as never);
    });
    await import(`./plan-run?case=${n++}`);
    return { code: await done, stderr };
  } finally {
    exit.mock.restore();
    err.mock.restore();
  }
}

test("plan-run: a session whose user is gone exits 1 with the re-mint sentence and runs no file", async () => {
  sessionFile = sessionNaming("0b0f0000-0000-4000-8000-000000000001");
  userExists = false;
  const { code, stderr } = await planRun();
  assert.equal(code, 1);
  assert.equal(stderr, "La sesión del carril 2 nombra un usuario que ya no existe: corre `npm run harness:mint-session`.");
  assert.equal(spawned, 0);
});

test("plan-run: no session file, or a file that is no session, exits 1 and runs no file", async () => {
  userExists = true;
  for (const file of [null, "not json", JSON.stringify({ cookies: [] })]) {
    sessionFile = file;
    const { code } = await planRun();
    assert.equal(code, 1, String(file));
    assert.equal(spawned, 0, String(file));
  }
});

test("plan-run: a live session runs both passes", async () => {
  sessionFile = sessionNaming("0b0f0000-0000-4000-8000-000000000002");
  userExists = true;
  const { code } = await planRun();
  assert.equal(code, 0);
  assert.equal(spawned, 2);
});
