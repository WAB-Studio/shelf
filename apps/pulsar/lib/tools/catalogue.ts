import { z } from "zod";

import { setMonthBudget } from "@/app/actions/budgets";
import { declareFact } from "@/app/actions/facts";
import {
  completeOneOff,
  createOneOff,
  fixTask,
  scheduleOneOff,
  setOneOffNote,
} from "@/app/actions/one-offs";
import {
  addCommitment,
  addPhase,
  createGoal,
  moveGoal,
  moveHorizon,
  renameGoal,
  retireCommitment,
  setGoalNote,
} from "@/app/actions/plan";
import { shapeDay, shapeGoal, shapeGoalList, shapeLoose, shapeMonth, shapeReport } from "@/lib/mcp/shape";
import { planMonthList } from "@/lib/plan/roadmap-read";
import { loadDay } from "@/lib/queries/day";
import { listGoalsForMetas, listLooseCommitments, loadGoal } from "@/lib/queries/goal";
import { listDaylessOneOffs, listScheduledOneOffs } from "@/lib/queries/one-offs";
import { loadReport } from "@/lib/queries/report";
import { todayInZone } from "@/lib/zone";

import mcp from "../../messages/es/mcp.json";

export type ToolOutcome =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string; values?: { name?: string; date?: string } };

export type ToolSpec = {
  name: keyof typeof mcp.tools;
  kind: "read" | "write";
  description: string;
  input: z.ZodObject;
  run(input: Record<string, unknown>): Promise<ToolOutcome>;
};

type ActResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string; values?: { name?: string; date?: string } };

const goalId = z.uuid();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month is YYYY-MM");

// The inputs of the writes are as loose as the wire allows: the act's own schema
// refuses a value, with its own key, and a stricter shape here would turn that
// refusal into a protocol error nobody can read.
const id = z.string();
const text = z.string();
const looseMonth = z.string();
const day = z.string();
const count = z.number();

// The tools speak snake_case; the acts' schemas speak camelCase. A key maps
// one to one, so nothing is renamed by guesswork.
function camelKeys(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), value]),
  );
}

function read(
  name: keyof typeof mcp.tools,
  input: z.ZodObject,
  load: (input: Record<string, unknown>) => Promise<ToolOutcome>,
): ToolSpec {
  return { name, kind: "read", description: mcp.tools[name], input, run: load };
}

export const readTools: readonly ToolSpec[] = [
  read("list_goals", z.object({}), async () => {
    const [list, loose] = await Promise.all([listGoalsForMetas(), listLooseCommitments()]);
    return { ok: true, value: shapeGoalList(list, loose) };
  }),
  read("get_goal", z.object({ goal_id: goalId }), async (input) => {
    const view = await loadGoal(input.goal_id as string);
    return view === null ? { ok: false, error: "mcp.errors.goalNotFound" } : { ok: true, value: shapeGoal(view) };
  }),
  read("get_month", z.object({ goal_id: goalId, month }), async (input) => {
    const view = await loadGoal(input.goal_id as string);
    if (view === null) return { ok: false, error: "mcp.errors.goalNotFound" };
    const first = `${input.month as string}-01`;
    const items = planMonthList(view.plan, first);
    return { ok: true, value: shapeMonth({ goalId: view.id, month: first, unit: view.measureUnit, items }) };
  }),
  read("get_today", z.object({}), async () => ({ ok: true, value: shapeDay(await loadDay(todayInZone())) })),
  read("get_report", z.object({}), async () => ({ ok: true, value: shapeReport(await loadReport(todayInZone())) })),
  read("list_loose_one_offs", z.object({}), async () => {
    const [dayless, scheduled] = await Promise.all([listDaylessOneOffs(), listScheduledOneOffs(todayInZone())]);
    return { ok: true, value: shapeLoose({ dayless, scheduled }) };
  }),
];

function write<S extends z.ZodRawShape>(
  name: keyof typeof mcp.tools,
  shape: S,
  act: (input: Record<string, unknown>) => Promise<ActResult>,
): ToolSpec {
  return {
    name,
    kind: "write",
    description: mcp.tools[name],
    input: z.object(shape),
    run: async (input) => {
      const result = await act(camelKeys(input));
      return result.ok ? { ok: true, value: result } : { ok: false, error: result.error, ...(result.values && { values: result.values }) };
    },
  };
}

const noteEmpty = (note: unknown) => typeof note !== "string" || note.trim() === "";
const refused: Promise<ActResult> = Promise.resolve({ ok: false, error: "mcp.errors.noteEmpty" });

export const writeTools: readonly ToolSpec[] = [
  write(
    "declare_fact",
    {
      commitment_id: id.optional(),
      one_off_id: id.optional(),
      quantity: count.optional(),
      note: text.optional(),
      day: day.optional(),
    },
    (input) => declareFact(input as Parameters<typeof declareFact>[0]),
  ),
  write("complete_task", { one_off_id: id }, (input) =>
    completeOneOff(input as Parameters<typeof completeOneOff>[0]),
  ),
  write(
    "create_task",
    {
      name: text,
      day: day.nullable().optional(),
      goal_id: id.optional(),
      estimate: count.optional(),
      planned_month: looseMonth.optional(),
      parent_id: id.optional(),
      note: text.optional(),
      in_plan: z.boolean().optional(),
    },
    // The schema takes a missing day as a refusal; a task with none is dayless.
    (input) => createOneOff({ day: null, ...input } as Parameters<typeof createOneOff>[0]),
  ),
  // A blank note would empty the task's: the person empties, the AI never does.
  write("set_task_note", { one_off_id: id, note: text }, (input) =>
    noteEmpty(input.note) ? refused : setOneOffNote(input as Parameters<typeof setOneOffNote>[0]),
  ),
  write("schedule_task", { one_off_id: id, day }, (input) =>
    scheduleOneOff(input as Parameters<typeof scheduleOneOff>[0]),
  ),
  write("set_month_amount", { goal_id: id, month: looseMonth, amount: count }, (input) =>
    setMonthBudget(input as Parameters<typeof setMonthBudget>[0]),
  ),
  write("rename_goal", { goal_id: id, name: text }, (input) =>
    renameGoal(input as Parameters<typeof renameGoal>[0]),
  ),
  write("add_phase", { goal_id: id, aim: text, starts_on: day, ends_on: day }, (input) =>
    addPhase(input as Parameters<typeof addPhase>[0]),
  ),
  write(
    "add_commitment",
    {
      goal_id: id.optional(),
      name: text,
      cadence_kind: z.enum(["daily", "weekdays", "times_per_week", "every_n_days", "times_per_month"]),
      cadence_weekdays: z.array(count).optional(),
      cadence_n: count.optional(),
      satisfaction: z.enum(["tap", "quantity", "evidence"]),
      target_quantity: count.optional(),
      unit: text.optional(),
      source_key: text.optional(),
      threshold: count.optional(),
    },
    (input) => addCommitment(input as Parameters<typeof addCommitment>[0]),
  ),
  // The AI gives and moves an end, never removes one (RP-56): a null is refused before the act.
  write("move_horizon", { goal_id: id, horizon: day.nullable() }, (input) =>
    input.horizon === null || input.horizon === undefined
      ? Promise.resolve({ ok: false, error: "mcp.errors.endKept" })
      : moveHorizon(input as Parameters<typeof moveHorizon>[0]),
  ),
  // Fixing never changes the goal's rhythm (RP-56): the act takes a task and a month alone.
  write("fix_task", { one_off_id: id, month: looseMonth }, (input) =>
    fixTask({ oneOffId: input.oneOffId, month: input.month } as Parameters<typeof fixTask>[0]),
  ),
  write("unfix_task", { one_off_id: id }, (input) =>
    fixTask({ oneOffId: input.oneOffId, month: null } as Parameters<typeof fixTask>[0]),
  ),
  write("create_goal", { name: text, horizon: day.optional(), parent_id: id.optional() }, (input) =>
    createGoal(input as Parameters<typeof createGoal>[0]),
  ),
  write("move_goal", { goal_id: id, parent_id: id.nullable() }, (input) =>
    moveGoal(input as Parameters<typeof moveGoal>[0]),
  ),
  // A blank note would empty the goal's: the person empties, the AI never does.
  write("set_goal_note", { goal_id: id, note: text }, (input) =>
    noteEmpty(input.note) ? refused : setGoalNote(input as Parameters<typeof setGoalNote>[0]),
  ),
  write("retire_commitment", { commitment_id: id }, (input) =>
    retireCommitment(input as Parameters<typeof retireCommitment>[0]),
  ),
];

export function writeTool(name: string): ToolSpec | null {
  return writeTools.find((tool) => tool.name === name) ?? null;
}
