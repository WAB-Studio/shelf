// Builds the plan `SEED` (tasks.ts) describes for each harness session it is given, through the app's own
// actions, and writes the ids the bench reads with `--seed` (run.ts). Rerunning on the same person finds
// every item by name before creating it, so a second run writes nothing new. Run from apps/goallog:
//   npx tsx --env-file=.env.local scripts/chat-bench/seed.ts \
//     --sessions private/session-8.json,private/session-9.json --out private/chat-bench-seed.json
// The in-process stubs are those of harness/seed-goal.ts, which runs at import and so cannot be imported.
import Module from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { SEED } from "./tasks";

type StoredCookie = { name: string; value: string };

// Swapped per session: the stubbed `cookies()` reads this on every call.
let cookies: StoredCookie[] = [];

function installStubs(): void {
  const untyped = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "server-only") return {};
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => cookies, set() {} }) };
    if (request === "next/cache") return { revalidatePath() {} };
    return originalLoad(request, parent, isMain);
  };
}

function flagValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

function loadCookies(file: string): StoredCookie[] {
  let state: { cookies: StoredCookie[] };
  try {
    state = JSON.parse(readFileSync(resolve(file), "utf8"));
  } catch {
    throw new Error(`no session at ${file} - run mint-session.ts first`);
  }
  if (state.cookies.length === 0) throw new Error(`${file} carries no cookie`);
  return state.cookies.map(({ name, value }) => ({ name, value }));
}

type Named = { id: string; name: string };
type Done = { ok: boolean; error?: string };

const ENGLISH_HORIZON = "2026-12-31";
const OCTOBER_END = "2026-10-31";
const PHASE_TWO = { startsOn: "2026-11-01", endsOn: "2026-11-30" };

function must<T extends Done>(label: string, result: T): T {
  if (!result.ok) throw new Error(`${label}: ${result.error}`);
  return result;
}

async function seedSession(): Promise<Record<keyof typeof SEED, string>> {
  const { readTools } = await import("@/lib/tools/catalogue");
  const { todayInZone } = await import("@/lib/zone");
  const { createGoal, addPhase, addCommitment, setGoalMeasure } = await import("@/app/actions/plan");
  const { setRhythm } = await import("@/app/actions/roadmap");
  const { createOneOff } = await import("@/app/actions/one-offs");
  const { getPerson } = await import("@/lib/session");

  const person = await getPerson();
  if (!person) throw new Error("no settled session - the cookie did not verify");
  console.log(`seeding as ${person.email} (${person.id})`);

  const read = async <T>(name: string, input: Record<string, unknown> = {}): Promise<T> => {
    const outcome = await readTools.find((spec) => spec.name === name)!.run(input);
    if (!outcome.ok) throw new Error(`${name}: ${outcome.error}`);
    return outcome.value as T;
  };
  type Tree = { id: string; name: string; children?: Tree[] };
  type GoalView = {
    measure: unknown;
    phases: { id: string; startsOn: string }[];
    commitments: (Named & { retiredAt: unknown })[];
    tasks: Tree[];
  };
  const goalView = (id: string) => read<GoalView>("get_goal", { goal_id: id });
  const flatten = (nodes: Tree[]): Named[] => nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);

  async function goalNamed(name: string, horizon?: string): Promise<string> {
    const list = await read<{ open: Named[]; ended: Named[] }>("list_goals");
    const hit = [...list.open, ...list.ended].find((goal) => goal.name === name);
    if (hit) return hit.id;
    const made = await createGoal({ name, horizon: horizon ?? null });
    if (!made.ok || !("goalId" in made)) throw new Error(`createGoal(${name}): refused`);
    return made.goalId;
  }

  const english = await goalNamed("Inglés", ENGLISH_HORIZON);
  const fitness = await goalNamed("Fitness");
  const house = await goalNamed("Casa");
  // A measure set never changes, so a Casa seeded before it had one gets it now and one that has it is left alone.
  if ((await goalView(house)).measure === null) {
    must("setGoalMeasure(Casa)", await setGoalMeasure({ goalId: house, name: "Horas", unit: "horas" }));
  }

  let view = await goalView(english);
  if (view.measure === null) {
    must("setGoalMeasure", await setGoalMeasure({ goalId: english, name: "Horas", unit: "horas" }));
  }
  // A time measure is stored in minutes, so 20 h a month is 1200; setting it again changes nothing.
  must("setRhythm", await setRhythm({ goalId: english, amount: 20 * 60 }));

  const today = todayInZone();
  if (view.phases.length === 0) {
    must("addPhase(1)", await addPhase({ goalId: english, aim: "Soltar la boca", startsOn: today, endsOn: OCTOBER_END }));
  }
  if (!view.phases.some((phase) => phase.startsOn === PHASE_TWO.startsOn)) {
    must("addPhase(2)", await addPhase({ goalId: english, aim: "Precisión", ...PHASE_TWO }));
  }
  if (!view.commitments.some((commitment) => commitment.name === "Clase de inglés" && !commitment.retiredAt)) {
    must(
      "addCommitment",
      await addCommitment({
        goalId: english,
        name: "Clase de inglés",
        cadenceKind: "weekdays",
        cadenceWeekdays: [1, 2, 3, 4, 5],
        satisfaction: "tap",
      }),
    );
  }

  const taskOf = async (name: string): Promise<string | undefined> =>
    flatten((await goalView(english)).tasks).find((task) => task.name === name)?.id;
  if ((await taskOf("Maze")) === undefined) {
    must("createOneOff(Maze)", await createOneOff({ goalId: english, name: "Maze", day: null, inPlan: true }));
  }
  if ((await taskOf("Documento")) === undefined) {
    must(
      "createOneOff(Documento)",
      await createOneOff({ goalId: english, name: "Documento", day: null, plannedMonth: "2026-11" }),
    );
  }
  const looseReport = async () =>
    (await read<{ dayless: (Named & { goalId: string | null })[] }>("list_loose_one_offs")).dayless.find(
      (task) => task.name === "Carta al banco" && task.goalId === null,
    )?.id;
  if ((await looseReport()) === undefined) {
    must("createOneOff(Carta al banco)", await createOneOff({ name: "Carta al banco", day: null }));
  }

  view = await goalView(english);
  const found: Record<keyof typeof SEED, string | undefined> = {
    "goal.english": english,
    "goal.fitness": fitness,
    "goal.house": house,
    "com.class": view.commitments.find((commitment) => commitment.name === "Clase de inglés" && !commitment.retiredAt)?.id,
    "task.maze": await taskOf("Maze"),
    "task.report": await looseReport(),
    "task.doc": await taskOf("Documento"),
    "phase.two": view.phases.find((phase) => phase.startsOn === PHASE_TWO.startsOn)?.id,
  };
  for (const key of Object.keys(SEED)) {
    if (!found[key as keyof typeof SEED]) throw new Error(`the plan holds nothing for ${key}`);
  }
  return found as Record<keyof typeof SEED, string>;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sessions = (flagValue(argv, "--sessions") ?? "").split(",").filter(Boolean);
  const out = flagValue(argv, "--out");
  if (sessions.length === 0 || !out) throw new Error("usage: seed.ts --sessions <file>[,<file>] --out <file>");

  installStubs();
  const outPath = resolve(out);
  // A session the run does not name keeps the ids an earlier run wrote.
  const result: Record<string, Record<string, string>> = existsSync(outPath)
    ? JSON.parse(readFileSync(outPath, "utf8"))
    : {};
  for (const session of sessions) {
    cookies = loadCookies(session);
    result[session] = await seedSession();
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`written to ${outPath}`);
}

void (async () => {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    console.error(`FAILED  ${(error as Error).message}`);
    process.exit(1);
  }
})();
