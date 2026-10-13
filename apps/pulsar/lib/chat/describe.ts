import { createTranslator } from "next-intl";

import chat from "../../messages/es/chat.json";
import units from "../../messages/es/units.json";
import { monthNameWithYear } from "../plan/month-name";
import { formatQuantity, type TimeWords } from "../units/time";
import { civilDayMonthShort, isCivilDate } from "../zone";
import type { ChangeNames } from "../queries/chat";
import type { Change } from "./types";

export type { ChangeNames };

export type Described = { key: string; values: Record<string, string> } | { refused: "chat.errors.notInPlan" };

const REFUSED = { refused: "chat.errors.notInPlan" } as const;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// Read straight from the catalogue: a change is described outside any request.
const translate = createTranslator({ locale: "es", messages: { units, chat } });
const words: TimeWords = {
  h: (h) => translate("units.h", { h }),
  min: (min) => translate("units.min", { min }),
  join: (h, min) => translate("units.join", { h, min }),
  unit: (unit, n) => {
    const word = unit.trim().toLowerCase();
    const key = `units.words.${word}`;
    return /^\p{L}+$/u.test(word) && (units.words as Record<string, string>)[word] !== undefined
      ? translate(key as Parameters<typeof translate>[0], { count: n })
      : unit;
  },
};

type Field =
  | { as: "goal" | "task" | "commitment"; from: string; to: string; optional?: boolean }
  | { as: "month" | "day" | "text"; from: string; to: string; optional?: boolean }
  | { as: "amount"; from: string; to: string; goal: string; optional?: boolean };

// Which input fields a tool shows, and what each is looked up as. An id field
// that is not here is never shown, so the model cannot smuggle a name in.
const FIELDS: Record<string, Field[]> = {
  declare_fact: [
    { as: "commitment", from: "commitment_id", to: "commitment", optional: true },
    { as: "task", from: "one_off_id", to: "task", optional: true },
    { as: "day", from: "day", to: "day", optional: true },
  ],
  complete_task: [{ as: "task", from: "one_off_id", to: "task" }],
  create_task: [
    { as: "text", from: "name", to: "name" },
    { as: "goal", from: "goal_id", to: "goal", optional: true },
    { as: "task", from: "parent_id", to: "parent", optional: true },
    { as: "month", from: "planned_month", to: "month", optional: true },
    { as: "day", from: "day", to: "day", optional: true },
  ],
  set_task_note: [{ as: "task", from: "one_off_id", to: "task" }],
  schedule_task: [
    { as: "task", from: "one_off_id", to: "task" },
    { as: "day", from: "day", to: "day" },
  ],
  set_month_amount: [
    { as: "goal", from: "goal_id", to: "goal" },
    { as: "month", from: "month", to: "month" },
    { as: "amount", from: "amount", to: "amount", goal: "goal_id" },
  ],
  rename_goal: [
    { as: "goal", from: "goal_id", to: "goal" },
    { as: "text", from: "name", to: "name" },
  ],
  add_phase: [
    { as: "goal", from: "goal_id", to: "goal" },
    { as: "text", from: "aim", to: "aim" },
    { as: "day", from: "starts_on", to: "from" },
    { as: "day", from: "ends_on", to: "to" },
  ],
  add_commitment: [
    { as: "goal", from: "goal_id", to: "goal" },
    { as: "text", from: "name", to: "name" },
  ],
  move_horizon: [
    { as: "goal", from: "goal_id", to: "goal" },
    { as: "day", from: "horizon", to: "day" },
  ],
  fix_task: [
    { as: "task", from: "one_off_id", to: "task" },
    { as: "month", from: "month", to: "month" },
  ],
  unfix_task: [{ as: "task", from: "one_off_id", to: "task" }],
  create_goal: [
    { as: "text", from: "name", to: "name" },
    { as: "goal", from: "parent_id", to: "parent", optional: true },
    { as: "day", from: "horizon", to: "day" },
  ],
  move_goal: [
    { as: "goal", from: "goal_id", to: "goal" },
    { as: "goal", from: "parent_id", to: "parent", optional: true },
  ],
  set_goal_note: [{ as: "goal", from: "goal_id", to: "goal" }],
  retire_commitment: [{ as: "commitment", from: "commitment_id", to: "commitment" }],
};

const say = (key: keyof typeof chat.before): string => translate(`chat.before.${key}` as Parameters<typeof translate>[0]);

function quantity(n: number, unit: string | null): string {
  return unit === null ? String(n) : formatQuantity(n, unit, words);
}

// «antes → después» of the tools that replace a value the person already holds.
function replaced(change: Change, names: ChangeNames, values: Record<string, string>): Record<string, string> {
  const goal = typeof change.input.goal_id === "string" ? names.goals.get(change.input.goal_id) : undefined;
  const task = typeof change.input.one_off_id === "string" ? names.tasks.get(change.input.one_off_id) : undefined;
  const commitment =
    typeof change.input.commitment_id === "string" ? names.commitments.get(change.input.commitment_id) : undefined;
  switch (change.tool) {
    case "set_month_amount": {
      const was = goal?.months[String(change.input.month).slice(0, 7)];
      return { before: was === undefined ? say("noAmount") : quantity(was, goal?.unit ?? null), after: values.amount };
    }
    case "fix_task":
      return { before: task?.month ? monthNameWithYear(task.month) : say("inPlan"), after: values.month };
    case "unfix_task":
      return { before: task?.month ? monthNameWithYear(task.month) : say("inPlan"), after: say("inPlan") };
    case "schedule_task":
      return { before: task?.day ? civilDayMonthShort(task.day) : say("noDay"), after: values.day };
    case "set_task_note":
      return { before: task?.hasNote ? say("withNote") : say("noNote"), after: say("withNote") };
    case "set_goal_note":
      return { before: goal?.hasNote ? say("withNote") : say("noNote"), after: say("withNote") };
    case "move_horizon":
      return { before: goal ? civilDayMonthShort(goal.horizon) : "", after: values.day };
    case "retire_commitment":
      return commitment?.target != null ? { before: quantity(commitment.target, commitment.unit) } : {};
    default:
      return {};
  }
}

// The sentence of a change, from its tool and the person's own names. The
// model's text never reaches it; an id the person does not own refuses it.
export function describeChange(change: Change, names: ChangeNames): Described {
  const fields = FIELDS[change.tool];
  if (fields === undefined) return REFUSED;
  const values: Record<string, string> = {};
  for (const field of fields) {
    const raw = change.input[field.from];
    if (raw === undefined || raw === null) {
      if (field.optional === true) continue;
      return REFUSED;
    }
    switch (field.as) {
      case "goal": {
        const found = typeof raw === "string" ? names.goals.get(raw) : undefined;
        if (found === undefined) return REFUSED;
        values[field.to] = found.name;
        break;
      }
      case "task": {
        const found = typeof raw === "string" ? names.tasks.get(raw) : undefined;
        if (found === undefined) return REFUSED;
        values[field.to] = found.name;
        break;
      }
      case "commitment": {
        const found = typeof raw === "string" ? names.commitments.get(raw) : undefined;
        if (found === undefined) return REFUSED;
        values[field.to] = found.name;
        break;
      }
      case "month":
        if (typeof raw !== "string" || !MONTH.test(raw.slice(0, 7))) return REFUSED;
        values[field.to] = monthNameWithYear(raw);
        break;
      case "day":
        if (typeof raw !== "string" || !isCivilDate(raw)) return REFUSED;
        values[field.to] = civilDayMonthShort(raw);
        break;
      case "text":
        if (typeof raw !== "string" || raw.trim() === "") return REFUSED;
        values[field.to] = raw.trim();
        break;
      case "amount": {
        const goalId = change.input[field.goal];
        const goal = typeof goalId === "string" ? names.goals.get(goalId) : undefined;
        if (goal === undefined || typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return REFUSED;
        values[field.to] = goal.unit === null ? String(raw) : formatQuantity(raw, goal.unit, words);
        break;
      }
    }
  }
  return { key: `chat.change.${change.tool}`, values: { ...values, ...replaced(change, names, values) } };
}
