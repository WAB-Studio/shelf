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
    setGoalNote: act("setGoalNote"),
  },
});
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

test("the catalogue holds the 22 names of mcp.json and no more", async () => {
  const { readTools, writeTools } = await catalogue();
  const names = [...readTools, ...writeTools].map((tool) => tool.name).sort();
  assert.deepEqual(names, Object.keys(mcp.tools).sort());
});

test("the 6 reads are reads and the 16 writes are writes", async () => {
  const { readTools, writeTools } = await catalogue();
  assert.equal(readTools.length, 6);
  assert.equal(writeTools.length, 16);
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
