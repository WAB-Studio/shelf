import assert from "node:assert/strict";
import test, { beforeEach, mock } from "node:test";

import mcp from "../../messages/es/mcp.json";

const calls: { act: string; input: unknown }[] = [];
function act(name: string) {
  return async (input: unknown) => {
    calls.push({ act: name, input });
    return { ok: true };
  };
}

mock.module("@/app/actions/budgets", { namedExports: { setMonthBudget: act("setMonthBudget") } });
mock.module("@/app/actions/facts", { namedExports: { declareFact: act("declareFact") } });
mock.module("@/app/actions/one-offs", {
  namedExports: {
    completeOneOff: act("completeOneOff"),
    createOneOff: act("createOneOff"),
    fixTask: act("fixTask"),
    scheduleOneOff: act("scheduleOneOff"),
    setOneOffNote: act("setOneOffNote"),
  },
});
mock.module("@/app/actions/plan", {
  namedExports: {
    addCommitment: act("addCommitment"),
    addPhase: act("addPhase"),
    createGoal: act("createGoal"),
    moveGoal: act("moveGoal"),
    moveHorizon: act("moveHorizon"),
    renameGoal: act("renameGoal"),
    retireCommitment: act("retireCommitment"),
    setGoalMeasure: act("setGoalMeasure"),
    setGoalNote: act("setGoalNote"),
  },
});
mock.module("@/app/actions/roadmap", { namedExports: { setRhythm: act("setRhythm") } });
mock.module("@/lib/queries/day", { namedExports: { loadDay: async () => ({}) } });
mock.module("@/lib/queries/goal", {
  namedExports: { listGoalsForMetas: async () => [], loadGoal: async () => null },
});
mock.module("@/lib/queries/one-offs", {
  namedExports: { listDaylessOneOffs: async () => [], listScheduledOneOffs: async () => [] },
});
mock.module("@/lib/queries/report", { namedExports: { loadReport: async () => ({}) } });
mock.module("@/lib/plan/roadmap-read", { namedExports: { planMonthList: () => [] } });

const catalogue = () => import("./catalogue");

beforeEach(() => {
  calls.length = 0;
});

test("the catalogue holds the 24 names of mcp.json and no more", async () => {
  const { readTools, writeTools } = await catalogue();
  const names = [...readTools, ...writeTools].map((tool) => tool.name).sort();
  assert.deepEqual(names, Object.keys(mcp.tools).sort());
});

test("the 6 reads are reads and the 18 writes are writes", async () => {
  const { readTools, writeTools } = await catalogue();
  assert.equal(readTools.length, 6);
  assert.equal(writeTools.length, 18);
  assert.ok(readTools.every((tool) => tool.kind === "read"));
  assert.ok(writeTools.every((tool) => tool.kind === "write"));
  assert.ok(!readTools.some((tool) => tool.name === "declare_fact"));
});

test("no tool deletes, archives, undoes or removes", async () => {
  const { readTools, writeTools, writeTool } = await catalogue();
  for (const tool of [...readTools, ...writeTools]) assert.doesNotMatch(tool.name, /delete|archive|undo|remove|reopen/);
  assert.equal(writeTool("archive_goal"), null);
  assert.equal(writeTool("get_goal"), null);
  assert.equal(writeTool("fix_task")?.name, "fix_task");
});

test("a blank goal note is refused and the act never runs", async () => {
  const { writeTool } = await catalogue();
  const outcome = await writeTool("set_goal_note")!.run({ goal_id: "g", note: "  " });
  assert.deepEqual(outcome, { ok: false, error: "mcp.errors.noteEmpty" });
  assert.equal(calls.length, 0);
});

test("a blank task note is refused and the act never runs", async () => {
  const { writeTool } = await catalogue();
  const outcome = await writeTool("set_task_note")!.run({ one_off_id: "t", note: "" });
  assert.deepEqual(outcome, { ok: false, error: "mcp.errors.noteEmpty" });
  assert.equal(calls.length, 0);
});

test("unfix_task calls fixTask with month null", async () => {
  const { writeTool } = await catalogue();
  await writeTool("unfix_task")!.run({ one_off_id: "t1" });
  assert.deepEqual(calls, [{ act: "fixTask", input: { oneOffId: "t1", month: null } }]);
});

test("a write answers through camelKeys", async () => {
  const { writeTool } = await catalogue();
  const outcome = await writeTool("rename_goal")!.run({ goal_id: "g1", name: "Nuevo" });
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls, [{ act: "renameGoal", input: { goalId: "g1", name: "Nuevo" } }]);
});

test("get_goal refuses an id that is not a uuid", async () => {
  const { readTools } = await catalogue();
  const spec = readTools.find((tool) => tool.name === "get_goal")!;
  assert.equal(spec.input.safeParse({ goal_id: "x" }).success, false);
  assert.equal(spec.input.safeParse({ goal_id: "7f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b" }).success, true);
});

test("get_goal on a goal that is not there answers goalNotFound", async () => {
  const { readTools } = await catalogue();
  const spec = readTools.find((tool) => tool.name === "get_goal")!;
  const outcome = await spec.run({ goal_id: "7f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b" });
  assert.deepEqual(outcome, { ok: false, error: "mcp.errors.goalNotFound" });
});

const ABOVE = "7f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b";

// What the server does with a call: parse the input with the tool's schema, then run it (RP-85).
async function call(name: string, wire: Record<string, unknown>) {
  const { writeTool } = await catalogue();
  const spec = writeTool(name)!;
  return spec.run(spec.input.parse(wire));
}

test("create_goal puts the goal inside the one named by parent_id, and at the top without it (RP-85)", async () => {
  await call("create_goal", { name: "Dentro", horizon: "2027-01-01", parent_id: ABOVE });
  await call("create_goal", { name: "Arriba", horizon: "2027-01-01" });
  assert.deepEqual(calls, [
    { act: "createGoal", input: { name: "Dentro", horizon: "2027-01-01", parentId: ABOVE } },
    { act: "createGoal", input: { name: "Arriba", horizon: "2027-01-01" } },
  ]);
});

test("move_goal moves a goal under another, and to the top with a null parent_id (RP-85, RP-82)", async () => {
  await call("move_goal", { goal_id: "g1", parent_id: ABOVE });
  await call("move_goal", { goal_id: "g1", parent_id: null });
  assert.deepEqual(calls, [
    { act: "moveGoal", input: { goalId: "g1", parentId: ABOVE } },
    { act: "moveGoal", input: { goalId: "g1", parentId: null } },
  ]);
});

test("set_rhythm calls setRhythm with the goal and the amount, and nothing else (RP-119)", async () => {
  await call("set_rhythm", { goal_id: "g1", amount: 40 });
  assert.deepEqual(calls, [{ act: "setRhythm", input: { goalId: "g1", amount: 40 } }]);
});

test("set_measure calls setGoalMeasure with the goal, the name and the unit (RP-117)", async () => {
  await call("set_measure", { goal_id: "g1", name: "Cajas embaladas", unit: "cajas" });
  assert.deepEqual(calls, [{ act: "setGoalMeasure", input: { goalId: "g1", name: "Cajas embaladas", unit: "cajas" } }]);
});

test("set_rhythm takes no null and no text: the AI never removes a rhythm (RP-119)", async () => {
  const { writeTool } = await catalogue();
  const spec = writeTool("set_rhythm")!;
  for (const amount of [null, "40", undefined]) {
    assert.equal(spec.input.safeParse({ goal_id: "g1", amount }).success, false, String(amount));
  }
  assert.equal(spec.input.safeParse({ goal_id: "g1", amount: 40 }).success, true);
});

// M19 · a tool refuses a key it does not declare, and each write carries the annotations its effect deserves.

const UUID = "7f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const VALID: Record<string, Record<string, unknown>> = {
  list_goals: {},
  get_goal: { goal_id: UUID },
  get_month: { goal_id: UUID, month: "2027-01" },
  get_today: {},
  get_report: {},
  list_loose_one_offs: {},
  declare_fact: {},
  complete_task: { one_off_id: "t" },
  create_task: { name: "x" },
  set_task_note: { one_off_id: "t", note: "n" },
  schedule_task: { one_off_id: "t", day: "2027-01-02" },
  set_month_amount: { goal_id: "g", month: "2027-01", amount: 1 },
  rename_goal: { goal_id: "g", name: "n" },
  add_phase: { goal_id: "g", aim: "a", starts_on: "2027-01-01", ends_on: "2027-01-31" },
  add_commitment: { name: "n", cadence_kind: "daily", satisfaction: "tap" },
  move_horizon: { goal_id: "g", horizon: null },
  fix_task: { one_off_id: "t", month: "2027-01" },
  unfix_task: { one_off_id: "t" },
  create_goal: { name: "n" },
  move_goal: { goal_id: "g", parent_id: null },
  set_goal_note: { goal_id: "g", note: "n" },
  retire_commitment: { commitment_id: "c" },
  set_rhythm: { goal_id: "g", amount: 1 },
  set_measure: { goal_id: "g", name: "n", unit: "u" },
};

test("every tool takes its own valid input and refuses the same input with a key it does not declare", async () => {
  const { readTools, writeTools } = await catalogue();
  assert.equal(Object.keys(VALID).length, 24);
  for (const tool of [...readTools, ...writeTools]) {
    const base = VALID[tool.name];
    assert.equal(tool.input.safeParse(base).success, true, `${tool.name} refuses its own valid input`);
    const extra = tool.input.safeParse({ ...base, goalId: UUID });
    assert.equal(extra.success, false, `${tool.name} accepted an undeclared key`);
    const issue = extra.error!.issues[0] as { code: string; keys?: string[] };
    assert.equal(issue.code, "unrecognized_keys", tool.name);
    assert.deepEqual(issue.keys, ["goalId"], `${tool.name} does not name the key`);
  }
});

test("create_task with goalId in camelCase is refused, not stripped into a loose task", async () => {
  const { writeTool } = await catalogue();
  const spec = writeTool("create_task")!;
  const parsed = spec.input.safeParse({ name: "x", goalId: UUID });
  assert.equal(parsed.success, false);
  assert.match(parsed.error!.issues[0].message, /Unrecognized key/);
  assert.match(parsed.error!.issues[0].message, /goalId/);
});

test("a read with an extra key (get_goal with include) is refused", async () => {
  const { readTools } = await catalogue();
  const spec = readTools.find((tool) => tool.name === "get_goal")!;
  assert.equal(spec.input.safeParse({ goal_id: UUID, include: [] }).success, false);
});

test("the JSON Schema each tool offers still says additionalProperties false", async () => {
  const { readTools, writeTools } = await catalogue();
  for (const tool of [...readTools, ...writeTools]) {
    // The conversion the MCP SDK makes for tools/list.
    const standard = tool.input["~standard"] as unknown as {
      jsonSchema: { input(options: { target: string }): { additionalProperties?: unknown } };
    };
    const schema = standard.jsonSchema.input({ target: "draft-2020-12" });
    assert.equal(schema.additionalProperties, false, tool.name);
  }
});

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
const IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
// M8: a create answers a replay of its request_id once, so the four creating tools are idempotent too.
const CREATING = ["create_task", "create_goal", "add_phase", "add_commitment"];

const ANNOTATIONS: [string[], Record<string, boolean>][] = [
  [["list_goals", "get_goal", "get_month", "get_today", "get_report", "list_loose_one_offs"], READ_ONLY],
  [["set_goal_note", "set_task_note", "set_measure", "retire_commitment", "move_horizon", "set_rhythm"], DESTRUCTIVE],
  [
    [
      "rename_goal",
      "schedule_task",
      "set_month_amount",
      "fix_task",
      "unfix_task",
      "complete_task",
      "declare_fact",
      "move_goal",
      ...CREATING,
    ],
    IDEMPOTENT,
  ],
];

test("each tool carries the annotations its effect deserves, and the three groups cover all 24", async () => {
  const { readTools, writeTools } = await catalogue();
  const byName = new Map([...readTools, ...writeTools].map((tool) => [tool.name as string, tool as { annotations?: unknown }]));
  assert.equal(ANNOTATIONS.flatMap(([names]) => names).length, 24);
  for (const [names, expected] of ANNOTATIONS) {
    for (const name of names) assert.deepEqual(byName.get(name)?.annotations, expected, name);
  }
});

test("the four creating tools are idempotent, neither read-only nor destructive (M8)", async () => {
  const { writeTool } = await catalogue();
  for (const name of CREATING) assert.deepEqual(writeTool(name)?.annotations, IDEMPOTENT, name);
});

const REQUEST_ID_SAYS = "Un uuid tuyo: si repites la llamada con el mismo, no se crea dos veces.";
const REQUEST = "0b6f3c1e-2a4d-4e8f-9c7b-5d1a2e3f4b6c";
const ACT_OF: Record<string, string> = {
  create_task: "createOneOff",
  create_goal: "createGoal",
  add_phase: "addPhase",
  add_commitment: "addCommitment",
};

test("the four creating tools take an optional request_id uuid, refuse one that is not, and say what it is for (M8)", async () => {
  const { writeTool } = await catalogue();
  for (const name of CREATING) {
    const spec = writeTool(name)!;
    const base = VALID[name];
    assert.equal(spec.input.safeParse(base).success, true, `${name} without request_id`);
    assert.equal(spec.input.safeParse({ ...base, request_id: REQUEST }).success, true, `${name} with a uuid request_id`);
    assert.equal(spec.input.safeParse({ ...base, request_id: "otra-vez" }).success, false, `${name} with a request_id no uuid`);
    const field = (spec.input.shape as Record<string, { description?: string }>).request_id;
    assert.equal(field?.description, REQUEST_ID_SAYS, `${name}'s request_id description`);
  }
});

test("a creating tool hands its request_id to the act as requestId (M8)", async () => {
  for (const name of CREATING) {
    calls.length = 0;
    await call(name, { ...VALID[name], request_id: REQUEST });
    assert.equal(calls.length, 1, name);
    assert.equal(calls[0].act, ACT_OF[name]);
    assert.equal((calls[0].input as Record<string, unknown>).requestId, REQUEST, `${name} lost the request id`);
  }
});
