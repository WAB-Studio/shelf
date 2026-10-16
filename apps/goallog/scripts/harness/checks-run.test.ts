import assert from "node:assert/strict";
import test, { mock } from "node:test";

// `checks-run.ts` runs `main()` at import and ends in `process.exit`. The
// doors it reaches through are replaced: the database, the run registry, the
// minting scripts and the four child processes. What the test drives is the
// verdict the script owes its caller: any red check, exit 1.
let statuses: Array<number | null> = [];
let spawned = 0;
let argvs: string[][] = [];
let dropFails = false;

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
    readFileSync: () =>
      JSON.stringify({
        scripts: {
          "check:day": "node a.ts",
          "check:goal": "node b.ts",
          "check:goal-actions": "node c.ts",
          "check:plan": 'node --test "scripts/plan/*.ts"',
        },
      }),
  },
});
mock.module("@repo/harness-registry", {
  namedExports: { openRun: async () => "run-1" },
});
mock.module("postgres", {
  defaultExport: () => ({}),
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
