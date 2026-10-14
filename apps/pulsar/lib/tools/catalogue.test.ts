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
