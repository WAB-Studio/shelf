import { z } from "zod";

import { dayBefore } from "@/lib/day/weeks";
import { monthsOfSpan } from "@/lib/plan/months";
import { isEnglishMinuteUnit, isHourUnit, isTimeUnit } from "@/lib/units/time";
import { addCommitmentSchema, addPhaseSchema, createGoalSchema, phaseWithinHorizon, phasesOverlap } from "@/lib/validation/plan";
import { setRhythmSchema } from "@/lib/validation/rhythm";
import { setMonthBudgetSchema } from "@/lib/validation/budget";
import { createOneOffSchema, noteSchema } from "@/lib/validation/one-off";
import { GOAL_NOTE_MAX } from "@/lib/validation/plan";

import { cleanLine, shortenName as shorten } from "./clean";
import { reshapeTasks } from "./reshape";

// The forms' own schemas judge what the import carries; the model's answer
// and the template are shaped around them, never a second set of rules.
const PLACEHOLDER_GOAL_ID = "00000000-0000-4000-8000-000000000000";

type Issue = { path: PropertyKey[]; message: string };

// Hands `value` to a form schema that wants a `goalId` the import has not got
// yet, and re-raises its issues here under their own keys.
function delegate<T>(
  form: z.ZodType,
  build: (value: T) => unknown,
): (value: T, ctx: z.core.$RefinementCtx<T>) => void {
  return (value, ctx) => {
    const parsed = form.safeParse(build(value));
    if (parsed.success) return;
    for (const issue of parsed.error.issues as Issue[]) {
      ctx.addIssue({ code: "custom", message: issue.message, path: issue.path.filter((p) => p !== "goalId") });
    }
  };
}

const unit = z
  .string({ error: "plan.errors.unitEmpty" })
  .trim()
  .min(1, { error: "plan.errors.unitEmpty" })
  .max(40, { error: "plan.errors.unitTooLong" });

const measure = z.strictObject({ name: createGoalSchema.shape.name, unit });

const phase = z
  .strictObject({
    aim: addPhaseSchema.shape.aim,
    startsOn: addPhaseSchema.shape.startsOn,
    endsOn: addPhaseSchema.shape.endsOn,
  })
  .superRefine(delegate(addPhaseSchema, (value) => ({ ...value, goalId: PLACEHOLDER_GOAL_ID })));

const month = z.strictObject({
  month: setMonthBudgetSchema.shape.month,
  // Minutes when the goal's unit is time (RP-35).
  amount: setMonthBudgetSchema.shape.amount,
});

// A model knows no evidence source: a commitment is a tap or a quantity.
// Absent parts are null rather than missing, so a strict model schema can
// name every field.
const commitment = z
  .strictObject({
    name: createGoalSchema.shape.name,
    cadenceKind: z.enum(["daily", "weekdays", "times_per_week", "every_n_days", "times_per_month"]),
    cadenceWeekdays: z.array(z.number().int()).nullable(),
    cadenceN: z.number().int().nullable(),
    satisfaction: z.enum(["tap", "quantity"]),
    targetQuantity: z.number().int().nullable(),
    unit: z.string().nullable(),
  })
  .superRefine(
    delegate(addCommitmentSchema, (value) => {
      const present = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null));
      return { ...present, goalId: PLACEHOLDER_GOAL_ID };
    }),
  );

const estimate = createOneOffSchema.shape.estimate.nonoptional();

// The note is the template's alone (RP-45): the model is sent the draft
// without it, and a draft that carries none reads as it always did.
function draftSchema(withNote: boolean) {
  // Typed as present either way: the types are the template's, the model's schema just leaves the key out.
  const note = (withNote ? { note: noteSchema.optional() } : {}) as { note: ReturnType<typeof noteSchema.optional> };
  const task = z.strictObject({
    name: createOneOffSchema.shape.name,
    month: setMonthBudgetSchema.shape.month,
    estimate,
    ...note,
    children: z.array(z.strictObject({ name: createOneOffSchema.shape.name, estimate, ...note })),
  });

  // The rhythm is the template's alone (RP-63), as the note is: the model's schema leaves the key out.
  const rhythm = (withNote ? { rhythm: setRhythmSchema.shape.amount.nullable().default(null) } : {}) as {
    rhythm: z.ZodDefault<z.ZodNullable<typeof setRhythmSchema.shape.amount>>;
  };
  const goal = z.strictObject({
    name: createGoalSchema.shape.name,
    horizon: createGoalSchema.shape.horizon,
    measure: measure.nullable(),
    ...rhythm,
    phases: z.array(phase),
    months: z.array(month),
    commitments: z.array(commitment),
    tasks: z.array(task),
  });

  return z.strictObject({
    goals: z
      .array(goal)
      .min(1, { error: "import.errors.empty" })
      .max(12, { error: "import.errors.draftInvalid" }),
  });
}

export const importDraftSchema = draftSchema(true);

// The one-level draft the template and the model still write, until 885 and 886 move them to version 2.
export type ImportDraftV1 = z.infer<typeof importDraftSchema>;

// What 151 hands the model as its response format.
export const importDraftJsonSchema = z.toJSONSchema(draftSchema(false));

export type DraftRefusal = { path: string; key: string; values?: Record<string, string> };

// What the draft holds that cannot be written, and why. Pure: the schema
// above says what is well-formed, this says what the goal's own span refuses.
export function draftRefusals(draft: ImportDraft | ImportDraftV1, today: string): DraftRefusal[] {
  return "version" in draft ? refusalsV2(draft, today) : refusalsV1(draft, today);
}

function refusalsV1(draft: ImportDraftV1, today: string): DraftRefusal[] {
  const refusals: DraftRefusal[] = [];
  draft.goals.forEach((goal, g) => {
    const at = `goals.${g}`;
    const refuse = (path: string, key: string, values?: Record<string, string>) =>
      refusals.push({ path: `${at}.${path}`, key, ...(values ? { values } : {}) });

    const past = goal.horizon <= today;
    if (past) refuse("horizon", "import.errors.horizonPast");

    goal.phases.forEach((phase, p) => {
      if (!phaseWithinHorizon(phase, goal.horizon)) refuse(`phases.${p}`, "plan.errors.phasePastHorizon");
      else if (goal.phases.slice(0, p).some((earlier) => phasesOverlap(earlier, phase))) {
        refuse(`phases.${p}`, "plan.errors.phaseOverlap");
      }
    });

    // A goal whose end already passed has no span: it is refused whole.
    const span = past ? null : new Set(monthsOfSpan(today, goal.horizon));
    const lastDay = dayBefore(goal.horizon);
    // Which side of the span a month falls on: before today's month or after the goal's last.
    const outsideSpan = (path: string, m: string) => {
      if (span === null || span.has(`${m}-01`)) return;
      if (m < today.slice(0, 7)) refuse(path, "import.errors.monthBeforeStart", { first: today.slice(0, 7) });
      else refuse(path, "import.errors.monthAfterEnd", { last: lastDay });
    };

    const seen = new Set<string>();
    goal.months.forEach((entry, m) => {
      outsideSpan(`months.${m}`, entry.month);
      if (seen.has(entry.month)) refuse(`months.${m}`, "import.errors.duplicateMonth");
      seen.add(entry.month);
      if (goal.measure === null) refuse(`months.${m}`, "import.errors.amountNoMeasure");
    });

    // A quantity counts in the goal's unit: with no measure there is none.
    goal.commitments.forEach((commitment, c) => {
      if (commitment.satisfaction === "quantity" && goal.measure === null) {
        refuse(`commitments.${c}`, "import.errors.quantityNoMeasure");
      }
      // A tap counts nothing: the table refuses a target or a unit on one.
      if (commitment.satisfaction === "tap" && (commitment.targetQuantity !== null || commitment.unit !== null)) {
        refuse(`commitments.${c}`, "import.errors.tapWithAmount");
      }
    });

    goal.tasks.forEach((task, t) => {
      outsideSpan(`tasks.${t}`, task.month);
      // A parent is measured by its sub-tasks; the policy refuses one with an estimate.
      if (task.children.length > 0 && task.estimate !== null) refuse(`tasks.${t}`, "import.errors.parentWithAmount");
      if (goal.measure === null) {
        if (task.estimate !== null) refuse(`tasks.${t}`, "month.errors.noMeasure");
        task.children.forEach((child, c) => {
          if (child.estimate !== null) refuse(`tasks.${t}.children.${c}`, "month.errors.noMeasure");
        });
      }
    });
  });
  return refusals;
}

// A goal measured in hours is kept in minutes (RP-65): its figures are multiplied
// by 60 once, and a draft already in minutes passes through unchanged.
export function inMinutes(draft: ImportDraft): ImportDraft;
export function inMinutes(draft: ImportDraftV1): ImportDraftV1;
export function inMinutes(draft: ImportDraft | ImportDraftV1): ImportDraft | ImportDraftV1 {
  // A version 2 draft is normalized into minutes already.
  if ("version" in draft) return draft;
  return {
    goals: draft.goals.map((goal) => {
      if (goal.measure === null || !isHourUnit(goal.measure.unit)) return goal;
      const times = (n: number | null) => (n === null ? null : n * 60);
      return {
        ...goal,
        measure: { ...goal.measure, unit: "minutos" },
        months: goal.months.map((entry) => ({ ...entry, amount: entry.amount * 60 })),
        commitments: goal.commitments.map((commitment) =>
          commitment.unit !== null && isHourUnit(commitment.unit)
            ? { ...commitment, unit: "minutos", targetQuantity: times(commitment.targetQuantity) }
            : commitment,
        ),
        tasks: goal.tasks.map((task) => ({
          ...task,
          estimate: times(task.estimate),
          children: task.children.map((child) => ({ ...child, estimate: times(child.estimate) })),
        })),
      };
    }),
  };
}

// What the helpers below read, shared by both draft versions.
type Estimated = { estimate: number | null };
type Shaped = {
  measure: { unit: string } | null;
  phases: { aim: string; startsOn: string; endsOn: string }[];
  tasks: (Estimated & { children: Estimated[] })[];
};

// A figure only a goal measured in time can keep (RP-66).
function keepsFigures(goal: Shaped): boolean {
  return goal.measure !== null && isTimeUnit(goal.measure.unit);
}

// The estimates a goal not measured in time cannot keep: a task's or a sub-task's.
export function strayEstimates(draft: { goals: Shaped[] }): DraftRefusal[] {
  const stray: DraftRefusal[] = [];
  draft.goals.forEach((goal, g) => {
    if (keepsFigures(goal)) return;
    const key = goal.measure === null ? "import.notices.estimateDropped" : "import.notices.estimateDroppedNotTime";
    goal.tasks.forEach((task, t) => {
      if (task.estimate !== null) stray.push({ path: `goals.${g}.tasks.${t}`, key });
      task.children.forEach((child, c) => {
        if (child.estimate !== null) stray.push({ path: `goals.${g}.tasks.${t}.children.${c}`, key });
      });
    });
  });
  return stray;
}

// The draft with those estimates nulled and nothing else changed: the task stays.
export function withoutStrayEstimates<D extends { goals: Shaped[] }>(draft: D): D {
  return {
    ...draft,
    goals: draft.goals.map((goal) =>
      keepsFigures(goal)
        ? goal
        : {
            ...goal,
            tasks: goal.tasks.map((task) => ({
              ...task,
              estimate: null,
              children: task.children.map((child) => ({ ...child, estimate: null })),
            })),
          },
    ),
  } as D;
}

// The phases that start before the goal opens (the day it is imported): each
// begins that day instead. One that ends before it is dropped, see `phaseDrops`.
export function phaseCuts(draft: { goals: Shaped[] }, today: string): { path: string; aim: string; from: string }[] {
  const cuts: { path: string; aim: string; from: string }[] = [];
  draft.goals.forEach((goal, g) => {
    goal.phases.forEach((phase, p) => {
      if (phase.startsOn < today && phase.endsOn >= today) cuts.push({ path: `goals.${g}.phases.${p}`, aim: phase.aim, from: today });
    });
  });
  return cuts;
}

// The phases wholly before the day the goal opens: nothing is left of them to keep.
export function phaseDrops(draft: { goals: Shaped[] }, today: string): { path: string; aim: string }[] {
  const drops: { path: string; aim: string }[] = [];
  draft.goals.forEach((goal, g) => {
    goal.phases.forEach((phase, p) => {
      if (phase.endsOn < today) drops.push({ path: `goals.${g}.phases.${p}`, aim: phase.aim });
    });
  });
  return drops;
}

// The draft with the cut phases starting `today` and the dropped ones gone; nothing else changes.
export function withCutPhases<D extends { goals: Shaped[] }>(draft: D, today: string): D {
  return {
    ...draft,
    goals: draft.goals.map((goal) => ({
      ...goal,
      phases: goal.phases
        .filter((phase) => phase.endsOn >= today)
        .map((phase) => (phase.startsOn < today ? { ...phase, startsOn: today } : phase)),
    })),
  } as D;
}

// ---- Version 2: the draft as a tree of goals, with the lines it came from.

// Lines (or rows, or parts) of the source, 1-based and inclusive.
export type Src = { from: number; to: number };
const src = z.array(z.strictObject({ from: z.number().int(), to: z.number().int() }));

// Bounds are judged by `draftRefusals`, never here: a part past one still has to be storable,
// to be shown and to be left out by name.
const phaseV2 = z.strictObject({ aim: z.string(), startsOn: z.string(), endsOn: z.string(), src });
const monthV2 = z.strictObject({ month: z.string(), amount: z.number().int(), src });
const commitmentV2 = z.strictObject({
  name: z.string(),
  cadenceKind: z.enum(["daily", "weekdays", "times_per_week", "every_n_days", "times_per_month"]),
  cadenceWeekdays: z.array(z.number().int()).nullable(),
  cadenceN: z.number().int().nullable(),
  satisfaction: z.enum(["tap", "quantity"]),
  targetQuantity: z.number().int().nullable(),
  unit: z.string().nullable(),
  src,
});
const measureV2 = z.strictObject({ name: z.string(), unit: z.string() });
// A rule of the plan («3 h of English every week»), kept in the goal's unit; checked, never written.
const ruleV2 = z.strictObject({ id: z.string(), label: z.string(), perWeek: z.number().int() });

const childV2 = z.strictObject({
  name: z.string(),
  estimate: z.number().int().nullable(),
  note: z.string().nullable(),
  noteSrc: src,
  src,
  rule: z.string().nullable(),
});
const taskV2 = z.strictObject({
  name: z.string(),
  month: z.string(),
  estimate: z.number().int().nullable(),
  note: z.string().nullable(),
  noteSrc: src,
  src,
  week: z.string().nullable(),
  rule: z.string().nullable(),
  // The day a task the plan marked done was done: it is written already done. Absent on a draft that predates it.
  doneOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  children: z.array(childV2),
});
const goalV2 = z.strictObject({
  key: z.string(),
  parent: z.string().nullable(),
  name: z.string(),
  horizon: z.string(),
  measure: measureV2.nullable(),
  rhythm: z.number().int().nullable(),
  note: z.string().nullable(),
  noteSrc: src,
  src,
  phases: z.array(phaseV2),
  months: z.array(monthV2),
  commitments: z.array(commitmentV2),
  rules: z.array(ruleV2),
  tasks: z.array(taskV2),
});

export const draftV2Schema = z.strictObject({
  version: z.literal(2),
  goals: z.array(goalV2).min(1, { error: "import.errors.empty" }).max(40, { error: "import.errors.draftInvalid" }),
});

export type ImportDraft = z.infer<typeof draftV2Schema>;
export type DraftGoal = ImportDraft["goals"][number];
export type DraftTask = DraftGoal["tasks"][number];

// What a reader answers before `normalize`: the same parts with no bound, `rate` for `rhythm`,
// figures in the plan's own unit, and `noteText` for a source with no lines to copy.
const rawChild = z.strictObject({
  name: z.string(),
  estimate: z.number().int().nullable(),
  rule: z.string().nullable(),
  noteSrc: src,
  noteText: z.string().nullable(),
  src,
});
const rawTask = z.strictObject({
  name: z.string(),
  month: z.string(),
  estimate: z.number().int().nullable(),
  week: z.string().nullable(),
  rule: z.string().nullable(),
  noteSrc: src,
  noteText: z.string().nullable(),
  src,
  children: z.array(rawChild),
});
const rawGoal = z.strictObject({
  key: z.string(),
  parent: z.string().nullable(),
  name: z.string(),
  horizon: z.string(),
  measure: measureV2.nullable(),
  rate: z.strictObject({ amount: z.number().int(), unit: z.enum(["minutes", "hours"]), per: z.enum(["week", "month"]) }).nullable(),
  noteSrc: src,
  noteText: z.string().nullable(),
  src,
  phases: z.array(phaseV2),
  months: z.array(monthV2),
  commitments: z.array(commitmentV2),
  rules: z.array(ruleV2),
  tasks: z.array(rawTask),
});
export const rawDraftSchema = z.strictObject({ goals: z.array(rawGoal) });
export type RawDraft = z.infer<typeof rawDraftSchema>;
export type RawGoal = RawDraft["goals"][number];
export type RawTask = RawGoal["tasks"][number];

// What 882 hands the model as its response format.
export const rawDraftJsonSchema = z.toJSONSchema(rawDraftSchema);

// `lines` is the text one line at a time for a text, a table's rows for a workbook; `null` for a
// source with no lines to copy (a PDF, an image), whose parts the reader names.
export type Source = { kind: "lines" | "rows" | "parts"; lines: string[] | null };

export type CorrectionCode =
  | "nameShortened"
  | "parentEstimateDropped"
  | "parentEstimateDiffers"
  | "cadenceClamped"
  | "cadenceToWeekdays"
  | "rateToRhythm"
  | "holderRhythmToNote"
  | "holderMonthsToNote"
  | "endWithinAbove"
  | "measureInHours"
  | "monthSumDiffers"
  | "monthOverRhythm"
  | "lineToTask"
  | "taskMoved";
export type NoticeCode = "weekRuleBroken" | "rhythmWithoutTasks";

// `id` is `at:code`. `declined` says what rejecting it does: keep what the plan said, or leave the part out.
export type Correction = {
  id: string;
  at: string;
  code: CorrectionCode;
  said: string;
  proposed: string;
  values?: Record<string, string>;
  declined: "keepsPlan" | "leavesOut";
};
export type Notice = { at: string; code: NoticeCode; values: Record<string, string> };

export const TASK_NOTE_MAX = 2000;
const CADENCE_CEILING: Record<string, number> = { times_per_week: 7, times_per_month: 31, every_n_days: 365 };

// The line numbers a list of ranges names, in order, once each, inside `total`.
export function srcLines(ranges: Src[], total: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const { from, to } of ranges) {
    for (let n = Math.max(from, 1); n <= Math.min(to, total); n++) {
      if (!seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
  }
  return out;
}

// The note of a part. With lines it is their literal text, whole lines up to `cap`, never the
// answer's words; a source with no lines takes the answer's `noteText`.
function buildNote(source: Source, ranges: Src[], noteText: string | null, cap: number, head: string | null): string | null {
  let body = "";
  if (source.kind === "parts") body = (noteText ?? "").trim();
  else if (source.lines !== null) {
    const texts = srcLines(ranges, source.lines.length).map((n) => cleanLine(source.lines![n - 1]));
    const room = cap - (head === null ? 0 : head.length + 2);
    for (let k = 1; k <= texts.length; k++) {
      const candidate = texts.slice(0, k).join("\n").trim();
      if (candidate.length > room) break;
      body = candidate;
    }
  }
  const note = [head, body].filter((part): part is string => part !== null && part !== "").join("\n\n");
  return note === "" ? null : note;
}

const DAY_WORDS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];

function cadenceSaid(c: { cadenceKind: string; cadenceN: number | null }): string {
  const n = c.cadenceN ?? 1;
  switch (c.cadenceKind) {
    case "times_per_week":
      return `${n} por semana`;
    case "times_per_month":
      return `${n} al mes`;
    case "every_n_days":
      return `cada ${n} días`;
    default:
      return "cada día";
  }
}

// The days live in `weekdays` alone and a count in the counted kinds alone, as the table holds them
// (`commitments_weekdays_for_weekdays`, `commitments_n_for_counted_kinds`). A model that names days on
// another kind meant those days: the plan's «Domingo» stays Sunday.
function cadenceShape<C extends { cadenceKind: string; cadenceWeekdays: number[] | null; cadenceN: number | null }>(
  c: C,
  at: string,
  add: (at: string, code: CorrectionCode, said: string, proposed: string, declined: Correction["declined"], values?: Record<string, string>) => unknown,
): C {
  const days = [...new Set(c.cadenceWeekdays ?? [])].filter((day) => day >= 1 && day <= 7).sort((a, b) => a - b);
  if (c.cadenceKind === "weekdays") return { ...c, cadenceN: null };
  if (days.length > 0) {
    add(at, "cadenceToWeekdays", cadenceSaid(c), days.map((day) => DAY_WORDS[day - 1]).join(", "), "leavesOut", {
      kind: c.cadenceKind,
      n: c.cadenceN === null ? "" : String(c.cadenceN),
      days: JSON.stringify(c.cadenceWeekdays),
    });
    return { ...c, cadenceKind: "weekdays", cadenceWeekdays: days, cadenceN: null };
  }
  return { ...c, cadenceWeekdays: null, cadenceN: c.cadenceKind === "daily" ? null : c.cadenceN };
}

const append = (note: string | null, text: string) => (note === null ? text : `${note}\n\n${text}`);

export function normalize(raw: RawDraft, source: Source): { draft: ImportDraft; corrections: Correction[] } {
  const corrections: Correction[] = [];
  const add = (at: string, code: CorrectionCode, said: string, proposed: string, declined: Correction["declined"], values?: Record<string, string>) =>
    corrections.push({ id: `${at}:${code}`, at, code, said, proposed, declined, ...(values ? { values } : {}) });
  const horizons = new Map<string, string>();
  const names = new Map<string, string>();
  const holders = new Set(raw.goals.flatMap((goal) => (goal.parent === null ? [] : [goal.parent])));
  const rateSaid = new Map<string, string>();

  const goals: DraftGoal[] = raw.goals.map((rg, g) => {
    const at = `goals.${g}`;
    const countsHours =
      rg.measure === null &&
      (rg.rate !== null ||
        rg.months.length > 0 ||
        rg.rules.length > 0 ||
        rg.tasks.some((t) => t.estimate !== null || t.children.some((c) => c.estimate !== null)));
    let measure = rg.measure;
    let times = 1;
    if (measure === null && countsHours) {
      measure = { name: "horas", unit: "minutos" };
      times = 60;
      add(at, "measureInHours", "", "horas", "keepsPlan");
    } else if (measure !== null && isHourUnit(measure.unit)) {
      measure = { ...measure, unit: "minutos" };
      times = 60;
    } else if (measure !== null && isEnglishMinuteUnit(measure.unit)) {
      measure = { ...measure, unit: "minutos" };
    }
    const figure = (n: number | null) => (n === null ? null : n * times);

    let rhythm: number | null = null;
    if (rg.rate !== null && measure !== null && isTimeUnit(measure.unit)) {
      const minutes = rg.rate.amount * (rg.rate.unit === "hours" ? 60 : 1);
      if (rg.rate.per === "month") rhythm = minutes;
      else {
        rhythm = Math.floor((minutes * 52) / 12);
        const said = `${rg.rate.amount} ${rg.rate.unit === "hours" ? "h" : "min"} por semana`;
        // A goal with goals inside moves the rhythm to its note, which says the plan's words.
        if (holders.has(rg.key)) rateSaid.set(rg.key, said);
        else add(`${at}.rhythm`, "rateToRhythm", said, String(rhythm), "keepsPlan", { minutes: String(rhythm) });
      }
    }

    const full = rg.name.trim();
    const name = shorten(full);
    if (name !== full) add(at, "nameShortened", full, name, "leavesOut");

    let horizon = rg.horizon;
    const above = rg.parent === null ? undefined : horizons.get(rg.parent);
    if (above !== undefined && horizon > above) {
      add(at, "endWithinAbove", horizon, above, "leavesOut", { was: horizon, above: names.get(rg.parent!) ?? "" });
      horizon = above;
    }
    horizons.set(rg.key, horizon);
    names.set(rg.key, name);

    const commitments = rg.commitments.map((c, i) => {
      let next = c;
      const ceiling = CADENCE_CEILING[c.cadenceKind];
      if (ceiling !== undefined && c.cadenceN !== null && c.cadenceN > ceiling) {
        add(`${at}.commitments.${i}`, "cadenceClamped", String(c.cadenceN), String(ceiling), "leavesOut", { was: String(c.cadenceN) });
        next = { ...next, cadenceN: ceiling };
      }
      if (next.unit !== null && isHourUnit(next.unit)) {
        next = { ...next, unit: "minutos", targetQuantity: next.targetQuantity === null ? null : next.targetQuantity * 60 };
      } else if (next.unit !== null && isEnglishMinuteUnit(next.unit)) {
        next = { ...next, unit: "minutos" };
      }
      return cadenceShape(next, `${at}.commitments.${i}`, add);
    });

    const tasks = rg.tasks.map((t, ti) => {
      const taskAt = `${at}.tasks.${ti}`;
      const taskFull = t.name.trim();
      const taskName = shorten(taskFull);
      if (taskName !== taskFull) add(taskAt, "nameShortened", taskFull, taskName, "leavesOut");
      const children = t.children.map((c, ci) => {
        const childAt = `${taskAt}.children.${ci}`;
        const childFull = c.name.trim();
        const childName = shorten(childFull);
        if (childName !== childFull) add(childAt, "nameShortened", childFull, childName, "leavesOut");
        return {
          name: childName,
          estimate: figure(c.estimate),
          note: buildNote(source, c.noteSrc, c.noteText, TASK_NOTE_MAX, childName !== childFull ? childFull : null),
          noteSrc: c.noteSrc,
          src: c.src,
          rule: c.rule,
        };
      });
      let estimate = figure(t.estimate);
      if (children.length > 0 && t.estimate !== null) {
        const sum = t.children.reduce((total, c) => total + (c.estimate ?? 0), 0);
        const unit = times === 60 ? "h" : (measure?.unit ?? "");
        if (t.estimate === sum) add(taskAt, "parentEstimateDropped", String(t.estimate), "", "leavesOut", { stored: String(estimate), unit });
        else {
          add(taskAt, "parentEstimateDiffers", String(t.estimate), String(sum), "leavesOut", {
            parent: String(t.estimate),
            children: String(sum),
            stored: String(estimate),
            unit,
          });
        }
        estimate = null;
      }
      return {
        name: taskName,
        month: t.month,
        estimate,
        note: buildNote(source, t.noteSrc, t.noteText, TASK_NOTE_MAX, taskName !== taskFull ? taskFull : null),
        noteSrc: t.noteSrc,
        src: t.src,
        week: t.week,
        rule: t.rule,
        children,
      };
    });

    return {
      key: rg.key,
      parent: rg.parent,
      name,
      horizon,
      measure,
      rhythm,
      note: buildNote(source, rg.noteSrc, rg.noteText, GOAL_NOTE_MAX, name !== full ? full : null),
      noteSrc: rg.noteSrc,
      src: rg.src,
      phases: rg.phases,
      months: rg.months.map((m) => ({ ...m, amount: m.amount * times })),
      commitments,
      rules: rg.rules.map((r) => ({ ...r, perWeek: r.perWeek * times })),
      tasks,
    };
  });

  // A goal with goals inside carries no rhythm and no month amounts (RP-80): they go to its note.
  goals.forEach((goal, g) => {
    if (!holders.has(goal.key)) return;
    const at = `goals.${g}`;
    const unit = goal.measure?.unit ?? "";
    if (goal.rhythm !== null) {
      const added = `ritmo: ${goal.rhythm} ${unit || "min"} al mes`;
      add(`${at}.rhythm`, "holderRhythmToNote", rateSaid.get(goal.key) ?? String(goal.rhythm), "", "leavesOut", { rhythm: String(goal.rhythm), added });
      goal.note = append(goal.note, added);
      goal.rhythm = null;
    }
    if (goal.months.length > 0) {
      const added = `meses: ${goal.months.map((m) => `${m.month} ${m.amount} ${unit}`.trim()).join("; ")}`;
      add(`${at}.months`, "holderMonthsToNote", String(goal.months.length), "", "leavesOut", { months: JSON.stringify(goal.months), added });
      goal.note = append(goal.note, added);
      goal.months = [];
    }
  });

  return { draft: { version: 2, goals }, corrections };
}

function withoutAdded(note: string | null, added: string | undefined): string | null {
  if (note === null || added === undefined) return note;
  const at = note.lastIndexOf(added);
  if (at < 0) return note;
  const stripped = `${note.slice(0, at).replace(/\n*$/, "")}\n\n${note.slice(at + added.length).replace(/^\n+/, "")}`.replace(/^\n+|\n+$/g, "");
  return stripped === "" ? null : stripped;
}

// The draft with what the person decided about each correction: a proposal the check made is
// applied unless declined; a fix `normalize` made is undone when declined, and the part is then
// refused by name, or keeps what the plan said.
export function decide(draft: ImportDraft, corrections: Correction[], declined: ReadonlySet<string>): ImportDraft {
  return decideWithPaths(draft, corrections, declined).draft;
}

// `decide`, and where each path of the stored draft lies once tasks have moved.
export function decideWithPaths(
  draft: ImportDraft,
  corrections: Correction[],
  declined: ReadonlySet<string>,
): { draft: ImportDraft; pathOf: (path: string) => string } {
  const next = structuredClone(draft);
  for (const c of corrections) {
    const parts = c.at.split(".");
    const goal = next.goals[Number(parts[1])];
    if (!goal) continue;
    const refused = declined.has(c.id);
    const task = parts[2] === "tasks" ? goal.tasks[Number(parts[3])] : undefined;
    const child = parts[4] === "children" && task ? task.children[Number(parts[5])] : undefined;
    const part = child ?? task ?? goal;
    switch (c.code) {
      case "monthSumDiffers":
        if (!refused && parts[2] === "months") goal.months[Number(parts[3])].amount = Number(c.proposed);
        break;
      case "monthOverRhythm":
        if (!refused) goal.months.push({ month: c.values?.month ?? "", amount: Number(c.proposed), src: [] });
        break;
      case "nameShortened":
        if (refused) {
          part.note = withoutHead(part.note, c.said);
          part.name = c.said;
        }
        break;
      case "parentEstimateDropped":
      case "parentEstimateDiffers":
        if (refused && task) task.estimate = Number(c.values?.stored);
        break;
      case "cadenceClamped":
        if (refused) goal.commitments[Number(parts[3])].cadenceN = Number(c.values?.was);
        break;
      case "cadenceToWeekdays":
        if (refused) {
          const entry = goal.commitments[Number(parts[3])];
          entry.cadenceKind = (c.values?.kind ?? entry.cadenceKind) as typeof entry.cadenceKind;
          entry.cadenceN = c.values?.n ? Number(c.values.n) : null;
          entry.cadenceWeekdays = JSON.parse(c.values?.days ?? "null") as number[] | null;
        }
        break;
      case "rateToRhythm":
        if (refused) goal.rhythm = null;
        break;
      case "holderRhythmToNote":
        if (refused) {
          goal.note = withoutAdded(goal.note, c.values?.added);
          goal.rhythm = Number(c.values?.rhythm);
        }
        break;
      case "holderMonthsToNote":
        if (refused) {
          goal.note = withoutAdded(goal.note, c.values?.added);
          goal.months = JSON.parse(c.values?.months ?? "[]") as typeof goal.months;
        }
        break;
      case "endWithinAbove":
        if (refused) goal.horizon = c.values?.was ?? goal.horizon;
        break;
      case "measureInHours":
      case "lineToTask":
      case "taskMoved":
        break;
    }
  }
  return reshapeTasks(next, corrections, declined);
}

// The note without the whole name `nameShortened` put at its head.
function withoutHead(note: string | null, full: string): string | null {
  if (note === null || !note.startsWith(full)) return note;
  const rest = note.slice(full.length).replace(/^\n+/, "");
  return rest === "" ? null : rest;
}

// ---- What version 2 refuses.

// The first message the form's own schema gives for `value`, or null.
function firstIssue(schema: z.ZodType, value: unknown): string | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? null : parsed.error.issues[0].message;
}

// The table's three checks on a commitment's columns, as one key or null: days only on `weekdays`,
// a count only on the counted kinds, a target and a unit only on a quantity.
export function commitmentShapeKey(c: {
  cadenceKind: string;
  cadenceWeekdays: number[] | null;
  cadenceN: number | null;
  satisfaction: string;
  targetQuantity: number | null;
  unit: string | null;
}): string | null {
  if (c.cadenceKind === "weekdays" ? (c.cadenceWeekdays?.length ?? 0) === 0 : c.cadenceWeekdays !== null) {
    return c.cadenceKind === "weekdays" ? "plan.errors.weekdaysEmpty" : "import.errors.cadenceWeekdays";
  }
  const counted = c.cadenceKind === "times_per_week" || c.cadenceKind === "every_n_days" || c.cadenceKind === "times_per_month";
  if (counted !== (c.cadenceN !== null && c.cadenceN > 0)) return "import.errors.cadenceCount";
  if ((c.satisfaction === "quantity") !== (c.targetQuantity !== null && c.unit !== null)) {
    return c.satisfaction === "quantity" ? "import.errors.quantityNoAmount" : "import.errors.tapWithAmount";
  }
  return null;
}

// The key of the first thing the commitment form's schema or the table's shape refuses in a commitment, or
// null. The review's sheet asks it of what the person typed, the server of what it is sent.
export function commitmentFormIssue(entry: {
  name: string;
  cadenceKind: "daily" | "weekdays" | "times_per_week" | "every_n_days" | "times_per_month";
  cadenceWeekdays: number[] | null;
  cadenceN: number | null;
  satisfaction: "tap" | "quantity";
  targetQuantity: number | null;
  unit: string | null;
}): string | null {
  return (
    firstIssue(commitment, {
      name: entry.name,
      cadenceKind: entry.cadenceKind,
      cadenceWeekdays: entry.cadenceWeekdays,
      cadenceN: entry.cadenceN,
      satisfaction: entry.satisfaction,
      targetQuantity: entry.targetQuantity,
      unit: entry.unit,
    }) ?? commitmentShapeKey(entry)
  );
}

// The refusals that leave a whole goal out, with the goals inside it (RP-90).
export const WHOLE_GOAL = /^goals\.\d+\.(horizon|parent|name|measure)$/;

function refusalsV2(draft: ImportDraft, today: string): DraftRefusal[] {
  const refusals: DraftRefusal[] = [];
  const seen = new Set<string>();
  const first = new Map<string, number>();
  draft.goals.forEach((goal, g) => {
    if (!first.has(goal.key)) first.set(goal.key, g);
  });
  const holders = new Set(draft.goals.flatMap((goal) => (goal.parent === null ? [] : [goal.parent])));
  // Levels above each goal, by walking up the keys; a goal that is not under an earlier one counts 0.
  const levelOf = (g: number): number => {
    let level = 0;
    let at = g;
    while (level < 9) {
      const parent = draft.goals[at].parent;
      const p = parent === null ? undefined : first.get(parent);
      if (p === undefined || p >= at) return level;
      level++;
      at = p;
    }
    return level;
  };

  draft.goals.forEach((goal, g) => {
    const at = `goals.${g}`;
    const refuse = (path: string, key: string, values?: Record<string, string>) => {
      const full = `${at}${path}`;
      if (seen.has(full)) return;
      seen.add(full);
      refusals.push({ path: full, key, ...(values ? { values } : {}) });
    };

    if (goal.parent !== null) {
      const p = first.get(goal.parent);
      if (p === undefined || p >= g) refuse(".parent", "tree.errors.notFound");
      else if (levelOf(g) > 2) refuse(".parent", "tree.errors.tooDeep");
      else if (goal.horizon > draft.goals[p].horizon) {
        refuse(".horizon", "tree.errors.endPastAbove", { name: draft.goals[p].name, date: draft.goals[p].horizon });
      }
    }
    const nameIssue = firstIssue(createGoalSchema.shape.name, goal.name);
    if (nameIssue) refuse(".name", nameIssue);
    const horizonIssue = firstIssue(createGoalSchema.shape.horizon, goal.horizon);
    if (horizonIssue) refuse(".horizon", horizonIssue);
    else if (goal.horizon <= today) refuse(".horizon", "import.errors.horizonPast");
    const measureIssue = goal.measure === null ? null : firstIssue(measure, goal.measure);
    if (measureIssue) refuse(".measure", measureIssue);

    const holder = holders.has(goal.key);
    if (goal.rhythm !== null) {
      if (holder) refuse(".rhythm", "tree.errors.holderNoRhythm");
      else {
        const issue = firstIssue(setRhythmSchema.shape.amount, goal.rhythm);
        if (issue) refuse(".rhythm", issue);
      }
    }
    if (goal.note !== null && goal.note.length > GOAL_NOTE_MAX) refuse(".note", "tree.errors.noteTooLong");

    const horizonOk = horizonIssue === null && goal.horizon > today;
    goal.phases.forEach((phaseValue, p) => {
      const issue = firstIssue(phase, { aim: phaseValue.aim, startsOn: phaseValue.startsOn, endsOn: phaseValue.endsOn });
      if (issue) refuse(`.phases.${p}`, issue);
      else if (horizonOk && !phaseWithinHorizon(phaseValue, goal.horizon)) refuse(`.phases.${p}`, "plan.errors.phasePastHorizon");
      else if (goal.phases.slice(0, p).some((earlier) => phasesOverlap(earlier, phaseValue))) refuse(`.phases.${p}`, "plan.errors.phaseOverlap");
    });

    const span = horizonOk ? new Set(monthsOfSpan(today, goal.horizon)) : null;
    const lastDay = horizonIssue === null ? dayBefore(goal.horizon) : goal.horizon;
    const outsideSpan = (path: string, m: string) => {
      if (span === null || span.has(`${m}-01`)) return;
      if (m < today.slice(0, 7)) refuse(path, "import.errors.monthBeforeStart", { first: today.slice(0, 7) });
      else refuse(path, "import.errors.monthAfterEnd", { last: lastDay });
    };

    const months = new Set<string>();
    goal.months.forEach((entry, m) => {
      const path = `.months.${m}`;
      const issue = firstIssue(month, { month: entry.month, amount: entry.amount });
      if (holder) refuse(path, "tree.errors.holderNoBudget");
      else if (issue) refuse(path, issue);
      else {
        outsideSpan(path, entry.month);
        if (months.has(entry.month)) refuse(path, "import.errors.duplicateMonth");
        if (goal.measure === null) refuse(path, "import.errors.amountNoMeasure");
      }
      months.add(entry.month);
    });

    goal.commitments.forEach((entry, c) => {
      const path = `.commitments.${c}`;
      const formIssue = commitmentFormIssue(entry);
      if (formIssue) refuse(path, formIssue);
      else if (entry.satisfaction === "quantity" && goal.measure === null) refuse(path, "import.errors.quantityNoMeasure");
      else if (entry.satisfaction === "tap" && (entry.targetQuantity !== null || entry.unit !== null)) refuse(path, "import.errors.tapWithAmount");
    });

    goal.tasks.forEach((task, t) => {
      const path = `.tasks.${t}`;
      const issue =
        firstIssue(createOneOffSchema.shape.name, task.name) ??
        firstIssue(setMonthBudgetSchema.shape.month, task.month) ??
        firstIssue(estimate.nullable(), task.estimate);
      if (issue) refuse(path, issue);
      else {
        outsideSpan(path, task.month);
        if (task.children.length > 0 && task.estimate !== null) refuse(path, "import.errors.parentWithAmount");
        else if (goal.measure === null && task.estimate !== null) refuse(path, "month.errors.noMeasure");
      }
      if (task.note !== null && task.note.length > TASK_NOTE_MAX) refuse(`${path}.note`, "day.errors.oneOffNoteTooLong");
      if (task.doneOn) {
        // A parent is done by its sub-tasks, and nothing is done after today.
        if (task.children.length > 0) refuse(path, "import.errors.doneWithSubtasks");
        else if (task.doneOn > today) refuse(path, "import.errors.doneInFuture");
      }
      task.children.forEach((child, c) => {
        const childPath = `${path}.children.${c}`;
        const childIssue = firstIssue(createOneOffSchema.shape.name, child.name) ?? firstIssue(estimate.nullable(), child.estimate);
        if (childIssue) refuse(childPath, childIssue);
        else if (goal.measure === null && child.estimate !== null) refuse(childPath, "month.errors.noMeasure");
        if (child.note !== null && child.note.length > TASK_NOTE_MAX) refuse(`${childPath}.note`, "day.errors.oneOffNoteTooLong");
      });
    });
  });
  return refusals;
}
