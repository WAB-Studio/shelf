import { z } from "zod";

import { setMonthBudget } from "@/app/actions/budgets";
import { declareFact } from "@/app/actions/facts";
import {
  completeOneOff,
  createOneOff,
  editTask,
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
  setGoalMeasure,
  setGoalNote,
} from "@/app/actions/plan";
import { editPhase } from "@/app/actions/plan-edit";
import { setRhythm } from "@/app/actions/roadmap";
import { shapeDay, shapeGoal, shapeGoalList, shapeLoose, shapeMonth, shapeReport } from "@/lib/mcp/shape";
import { planMonthList } from "@/lib/plan/roadmap-read";
import { loadDay } from "@/lib/queries/day";
import { listGoalsForMetas, listLooseCommitments, loadGoal } from "@/lib/queries/goal";
import { listDaylessOneOffs, listGoalOneOffs, listScheduledOneOffs } from "@/lib/queries/one-offs";
import { loadReport } from "@/lib/queries/report";
import { todayInZone } from "@/lib/zone";

import mcp from "../../messages/es/mcp.json";

export type ToolOutcome =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string; values?: { name?: string; date?: string; quantity?: number; unit?: string | null } };

export type ToolAnnotations = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };

export type ToolSpec = {
  name: keyof typeof mcp.tools;
  kind: "read" | "write";
  description: string;
  input: z.ZodObject;
  annotations: ToolAnnotations;
  run(input: Record<string, unknown>): Promise<ToolOutcome>;
};

type ActResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string; values?: { name?: string; date?: string; quantity?: number; unit?: string | null } };

const goalId = z.uuid();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month is YYYY-MM");

// The inputs of the writes are as loose as the wire allows: the act's own schema
// refuses a value, with its own key, and a stricter shape here would turn that
// refusal into a protocol error nobody can read.
const id = z.string();
const text = z.string();
const looseMonth = z.string();
const day = z.string();
const count = z.number();
// Unlike the rest, refused here: an id that is no uuid would reach no receipt.
const requestId = z.uuid().optional().describe(mcp.fields.request_id);

// The tools speak snake_case; the acts' schemas speak camelCase. A key maps
// one to one, so nothing is renamed by guesswork.
function camelKeys(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), value]),
  );
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
// A creating tool is idempotent too: a resend with its `request_id` answers the first answer (RP-56).
const IDEMPOTENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };

// A replaced note, measure, end or rhythm cannot be read back after the write, so a client asks first.
const DESTRUCTIVE_WRITES: ReadonlySet<string> = new Set([
  "set_goal_note",
  "set_task_note",
  "set_measure",
  "retire_commitment",
  "move_horizon",
  "set_rhythm",
]);

function writeAnnotations(name: string): ToolAnnotations {
  return DESTRUCTIVE_WRITES.has(name) ? DESTRUCTIVE : IDEMPOTENT;
}

function read(
  name: keyof typeof mcp.tools,
  input: z.ZodObject,
  load: (input: Record<string, unknown>) => Promise<ToolOutcome>,
): ToolSpec {
  return { name, kind: "read", description: mcp.tools[name], input, annotations: READ_ONLY, run: load };
}

export const readTools: readonly ToolSpec[] = [
  read("list_goals", z.strictObject({}), async () => {
    const [list, loose] = await Promise.all([listGoalsForMetas(), listLooseCommitments()]);
    return { ok: true, value: shapeGoalList(list, loose) };
  }),
  read("get_goal", z.strictObject({ goal_id: goalId }), async (input) => {
    const view = await loadGoal(input.goal_id as string);
    return view === null ? { ok: false, error: "mcp.errors.goalNotFound" } : { ok: true, value: shapeGoal(view) };
  }),
  read("get_month", z.strictObject({ goal_id: goalId, month }), async (input) => {
    const view = await loadGoal(input.goal_id as string);
    if (view === null) return { ok: false, error: "mcp.errors.goalNotFound" };
    const first = `${input.month as string}-01`;
    const items = planMonthList(view.plan, first);
    return { ok: true, value: shapeMonth({ goalId: view.id, month: first, unit: view.measureUnit, items }) };
  }),
  read("get_today", z.strictObject({}), async () => ({ ok: true, value: shapeDay(await loadDay(todayInZone())) })),
  read("get_report", z.strictObject({}), async () => ({ ok: true, value: shapeReport(await loadReport(todayInZone())) })),
  read("list_loose_one_offs", z.strictObject({}), async () => {
    const today = todayInZone();
    const [dayless, scheduled, inGoals] = await Promise.all([
      listDaylessOneOffs(),
      listScheduledOneOffs(today),
      listGoalOneOffs(today),
    ]);
    return { ok: true, value: shapeLoose({ dayless, scheduled, inGoals }) };
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
    input: z.strictObject(shape),
    annotations: writeAnnotations(name),
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
  write("complete_task", { one_off_id: id, day: day.optional() }, (input) =>
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
      request_id: requestId,
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
  write("add_phase", { goal_id: id, aim: text, starts_on: day, ends_on: day, request_id: requestId }, (input) =>
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
      request_id: requestId,
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
  // The act asks for the task's name with every edit; the tool sends the task's own, so only the estimate changes.
  write("set_task_estimate", { one_off_id: id, estimate: count.nullable() }, async (input) => {
    const target = input.oneOffId;
    // An id that is no uuid goes to the act as it is, which refuses it with its own key.
    if (typeof target !== "string" || !UUID.test(target)) return editTask({ ...input, name: "-" } as Parameters<typeof editTask>[0]);
    const { loadChangeNames } = await import("@/lib/queries/chat");
    const task = (await loadChangeNames({ goals: [], tasks: [target], commitments: [] })).tasks.get(target);
    if (task === undefined) return { ok: false, error: "plan.errors.notFound" };
    return editTask({ oneOffId: target, name: task.name, estimate: input.estimate } as Parameters<typeof editTask>[0]);
  }),
  write("edit_phase", { phase_id: id, aim: text, starts_on: day, ends_on: day }, (input) =>
    editPhase(input),
  ),
  write("create_goal", { name: text, horizon: day.optional(), parent_id: id.optional(), request_id: requestId }, (input) =>
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
  // Gives or changes a rhythm, never takes it away (RP-119): the amount has no null.
  write("set_rhythm", { goal_id: id, amount: count }, (input) =>
    setRhythm(input as Parameters<typeof setRhythm>[0]),
  ),
  // Only a goal that does not measure yet; a measure set never changes (RP-119).
  write("set_measure", { goal_id: id, name: text, unit: text }, (input) =>
    setGoalMeasure(input as Parameters<typeof setGoalMeasure>[0]),
  ),
];

export function writeTool(name: string): ToolSpec | null {
  return writeTools.find((tool) => tool.name === name) ?? null;
}
