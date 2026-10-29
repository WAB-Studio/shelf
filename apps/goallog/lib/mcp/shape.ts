import { createTranslator } from "next-intl";

import type { Cadence, Phase, ReviewWeek, SatisfiedBy } from "@/lib/day/types";
import type { Report } from "@/lib/export/report";
import { monthOfTask } from "@/lib/plan/carry";
import { settledMonths, type MonthLine } from "@/lib/plan/months";
import type { PlanItem, PlanTask, Roadmap } from "@/lib/plan/roadmap";
import { planShare } from "@/lib/plan/roadmap-read";
import { civilDateInZone } from "@/lib/zone";
import { formatQuantity, isTimeUnit } from "@/lib/units/time";
import type { loadDay } from "@/lib/queries/day";
import type { GoalCommitment, GoalView, LooseCommitment, MetasSummary } from "@/lib/queries/goal";
import type { DaylessOneOff, GoalOneOff, ScheduledOneOff } from "@/lib/queries/one-offs";

import units from "../../messages/es/units.json";

// The words for a minute, from the catalogue directly: a tool answers outside
// a request, where the request config does not run.
const translate = createTranslator({ locale: "es", messages: { units } });
const WORDS = {
  h: (h: string) => translate("units.h", { h }),
  min: (min: string) => translate("units.min", { min }),
  join: (h: string, min: string) => translate("units.join", { h, min }),
};

// An integer and the word that counts it. `text` appears for time alone, where
// «750» is not how a person reads twelve and a half hours. `unit` is null where
// the goal measures nothing.
export type Amount = { value: number; unit: string | null; text?: string };

export function amountOf(value: number, unit: string | null): Amount {
  if (!Number.isInteger(value)) throw new Error(`an amount is an integer, got ${value}`);
  if (unit === null) return { value, unit };
  return isTimeUnit(unit) ? { value, unit, text: formatQuantity(value, unit, WORDS) } : { value, unit };
}

function amountOrNull(value: number | null, unit: string | null): Amount | null {
  return value === null ? null : amountOf(value, unit);
}

// "YYYY-MM-01" and "YYYY-MM" both read "YYYY-MM".
export function monthKey(month: string): string {
  return month.slice(0, 7);
}

function monthOrNull(month: string | null): string | null {
  return month === null ? null : monthKey(month);
}

// The engine's own "YYYY-MM" start of a month, for the pure helpers that want it.
function firstOf(month: string): string {
  return `${monthKey(month)}-01`;
}

export type ShapedTask = {
  id: string;
  name: string;
  month: string | null;
  fixed: boolean;
  day: string | null;
  estimate: Amount | null;
  doneOn: string | null;
  note: string | null;
  children: ShapedTask[];
};

// Where the plan sits each task: the month of its first part, and whether the
// person (or the AI) fixed it there.
type Placement = Map<string, { month: string; fixed: boolean }>;

function placementOf(roadmap: Roadmap): Placement {
  const placed: Placement = new Map();
  for (const month of roadmap.months) {
    for (const item of month.items) {
      if (!placed.has(item.task.id)) placed.set(item.task.id, { month: month.month, fixed: item.fixed });
    }
  }
  return placed;
}

function shapeTask(
  task: PlanTask,
  unit: string | null,
  children: PlanTask[],
  placed: Placement,
  parent: { month: string | null; fixed: boolean } | null,
): ShapedTask {
  const own = placed.get(task.id);
  const fixedMonth = monthOfTask(task);
  const where =
    parent ?? {
      month: own?.month ?? fixedMonth,
      fixed: own?.fixed ?? fixedMonth !== null,
    };
  return {
    id: task.id,
    name: task.name,
    month: monthOrNull(where.month),
    fixed: where.fixed,
    day: task.day,
    estimate: amountOrNull(task.estimate, unit),
    doneOn: task.doneOn,
    note: task.note ?? null,
    children: children.map((child) => shapeTask(child, unit, [], placed, where)),
  };
}

// The flat rows as a tree; a sub-task whose parent is missing stays at the top
// rather than vanish.
function taskTree(tasks: PlanTask[], unit: string | null, placed: Placement): ShapedTask[] {
  const ids = new Set(tasks.map((task) => task.id));
  return tasks
    .filter((task) => task.parentId === null || !ids.has(task.parentId))
    .map((task) =>
      shapeTask(
        task,
        unit,
        tasks.filter((child) => child.parentId === task.id),
        placed,
        null,
      ),
    );
}

function shapeCadence(cadence: Cadence): Cadence {
  return cadence.kind === "weekdays" ? { kind: "weekdays", days: [...cadence.days] } : { ...cadence };
}

function shapeSatisfiedBy(by: SatisfiedBy): {
  kind: SatisfiedBy["kind"];
  target: Amount | null;
} {
  if (by.kind === "tap") return { kind: "tap", target: null };
  return {
    kind: by.kind,
    target: amountOf(by.kind === "quantity" ? by.target : by.threshold, by.unit),
  };
}

function shapePhase(phase: Phase) {
  return { id: phase.id, name: phase.name, startsOn: phase.startsOn, endsOn: phase.endsOn };
}

function shapeWeek(week: ReviewWeek, unit: string | null) {
  return {
    index: week.index,
    startsOn: week.startsOn,
    endsOn: week.endsOn,
    total: amountOf(week.total, unit),
    phaseName: week.phaseName,
    current: week.current,
  };
}

function shapeMeasure(name: string | null, unit: string | null) {
  return name === null || unit === null ? null : { name, unit };
}

function shapeLine(line: MonthLine & { month?: string }, unit: string | null) {
  return {
    planned: amountOrNull(line.planned, unit),
    reached: amountOf(line.reached, unit),
    underPace: line.underPace,
  };
}

function shapeGoalCommitment(commitment: GoalCommitment) {
  return {
    id: commitment.id,
    name: commitment.name,
    cadence: shapeCadence(commitment.cadence),
    satisfiedBy: shapeSatisfiedBy(commitment.satisfiedBy),
    retiredAt: commitment.retiredAt,
    daysDone: commitment.factDayCount,
    evidenceSource: commitment.sourceLabelKey,
  };
}

export function shapeGoalList(
  list: { open: MetasSummary[]; ended: MetasSummary[]; archived: MetasSummary[] },
  loose: LooseCommitment[] = [],
) {
  // The goals directly under each, in the order the list holds them.
  const childIds = new Map<string, string[]>();
  for (const goal of [...list.open, ...list.ended, ...list.archived]) {
    if (goal.parentId !== null) childIds.set(goal.parentId, [...(childIds.get(goal.parentId) ?? []), goal.id]);
  }
  const one = (goal: MetasSummary) => ({
    id: goal.id,
    name: goal.name,
    horizon: goal.horizon,
    measure: shapeMeasure(goal.measureName, goal.measureUnit),
    archivedAt: goal.archivedAt,
    parentId: goal.parentId,
    level: goal.level,
    childIds: childIds.get(goal.id) ?? [],
  });
  return {
    open: list.open.map(one),
    ended: list.ended.map(one),
    archived: list.archived.map(one),
    // Habits with no goal (RP-100), live and retired.
    looseHabits: loose.map((habit) => ({ ...shapeGoalCommitment(habit), note: habit.note })),
  };
}

export function shapeGoal(view: GoalView) {
  const unit = view.measureUnit;
  return {
    id: view.id,
    name: view.name,
    horizon: view.horizon,
    endedOn: view.endedOn,
    openedOn: civilDateInZone(new Date(view.createdAt)),
    archivedAt: view.archivedAt,
    measure: shapeMeasure(view.measureName, unit),
    measureTotal: unit === null ? null : amountOf(view.measureTotal, unit),
    evidence: view.evidence,
    thisMonth:
      view.month === null
        ? null
        : { month: monthKey(view.month.month), ...shapeLine(view.month, unit) },
    phases: view.phases.map(shapePhase),
    commitments: view.commitments.map(shapeGoalCommitment),
    // The goal's units per month (RP-50); the AI sets it with `set_rhythm` (RP-119). Null for a goal that holds goals.
    rhythm: amountOrNull(view.rhythm, unit),
    // The day the plan's last task fills, null while it cannot say.
    end: view.roadmap.end,
    months: settledMonths(view.months, view.endedOn !== null).map((row) => {
      // The screen reads a share for a finished month alone.
      const share = row.past ? planShare(view.plan, firstOf(row.month)) : null;
      return {
        month: monthKey(row.month),
        planned: amountOrNull(row.planned, unit),
        reached: amountOf(row.reached, unit),
        carried: share === null ? null : amountOf(share.carried, unit),
        carriedPercent: share === null ? null : Math.floor((share.carried * 100) / share.planned),
        current: row.current,
        past: row.past,
      };
    }),
    tasks: taskTree(view.tasks, unit, placementOf(view.roadmap)),
    weeks: view.weeks.map((week) => shapeWeek(week, unit)),
    parent: view.parent === null ? null : { id: view.parent.id, name: view.parent.name },
    children: view.children.map((child) => ({
      id: child.id,
      name: child.name,
      level: child.level,
      thisMonth:
        child.month === null
          ? null
          : { planned: amountOrNull(child.month.planned, child.unit), reached: amountOf(child.month.reached, child.unit) },
    })),
    level: view.level,
    holdsGoals: view.holdsGoals,
    note: view.note,
    outOfUnit: view.outOfUnit.map((other) => ({ id: other.id, name: other.name, unit: other.unit })),
  };
}

// One month's list as `planMonthList` returns it: carried tasks first, then
// the month's own, each with its part of the task and where the rest sits.
export function shapeMonth(input: { goalId: string; month: string; unit: string | null; items: PlanItem[] }) {
  const { unit } = input;
  return {
    goalId: input.goalId,
    month: monthKey(input.month),
    items: input.items.map((item) => ({
      id: item.task.id,
      name: item.task.name,
      day: item.task.day,
      estimate: amountOrNull(item.task.estimate, unit),
      doneOn: item.task.doneOn,
      note: item.task.note ?? null,
      children: item.children.map((child) => ({
        id: child.id,
        name: child.name,
        day: child.day,
        estimate: amountOrNull(child.estimate, unit),
        doneOn: child.doneOn,
        note: child.note ?? null,
      })),
      part: amountOf(item.part, unit),
      from: monthOrNull(item.from),
      to: monthOrNull(item.to),
      fixed: item.fixed,
      carriedFrom: monthOrNull(item.carriedFrom),
      hasAmount:
        item.children.length === 0
          ? item.task.estimate !== null
          : item.children.some((child) => child.estimate !== null),
      done: item.done,
    })),
  };
}

type LoadedDay = Awaited<ReturnType<typeof loadDay>>;

export function shapeDay(loaded: LoadedDay) {
  const { view } = loaded;
  const goalUnit = new Map(loaded.goals.map((goal) => [goal.id, goal.measureUnit]));
  const info = new Map(loaded.commitments.map((commitment) => [commitment.id, commitment]));
  const slotOf = (slot: (typeof view.slots)[number]) => {
    const commitment = info.get(slot.commitmentId);
    const unit = commitment?.unit ?? goalUnit.get(commitment?.goalId ?? "") ?? null;
    return {
      commitmentId: slot.commitmentId,
      goalId: commitment?.goalId ?? null,
      name: commitment?.name ?? null,
      cadence: commitment === undefined ? null : shapeCadence(commitment.cadence),
      kind: commitment?.kind ?? null,
      target: commitment === undefined ? null : amountOrNull(commitment.target, commitment.unit),
      satisfied: slot.satisfied,
      satisfiedBy: slot.satisfiedBy,
      quantity: amountOrNull(slot.quantity, unit),
      periodDone: loaded.periodDone[slot.commitmentId] ?? null,
    };
  };
  return {
    day: view.day,
    evidence: loaded.evidence,
    phase: view.phase === null ? null : shapePhase(view.phase),
    goals: loaded.goals.map((goal) => {
      const week = loaded.weekMeasure[goal.id];
      const line = loaded.monthLine[goal.id];
      return {
        id: goal.id,
        name: goal.name,
        horizon: goal.horizon,
        openedOn: goal.openedOn,
        measure: shapeMeasure(goal.measureName, goal.measureUnit),
        weekTotal: week === undefined ? null : amountOf(week, goal.measureUnit),
        thisMonth: line === undefined ? null : shapeLine(line, goal.measureUnit),
      };
    }),
    slots: view.slots.map(slotOf),
    // Habits with no goal (RP-100): the commitments and what they ask today.
    loose: {
      commitments: loaded.loose.commitments.map((commitment) => ({
        id: commitment.id,
        name: commitment.name,
        cadence: shapeCadence(commitment.cadence),
        kind: commitment.kind,
        target: amountOrNull(commitment.target, commitment.unit),
      })),
      slots: loaded.loose.slots.map(slotOf),
    },
    oneOffs: loaded.oneOffs.map((oneOff) => ({
      id: oneOff.id,
      goalId: oneOff.goalId,
      name: oneOff.name,
      note: oneOff.note,
      day: oneOff.day,
      carried: oneOff.day !== null && oneOff.day < view.day,
    })),
    doneOneOffs: loaded.doneOneOffs.map((oneOff) => ({
      id: oneOff.id,
      goalId: oneOff.goalId,
      name: oneOff.name,
      note: oneOff.note,
      factId: oneOff.factId,
      writtenAt: oneOff.writtenAt,
    })),
    daylessCount: loaded.daylessCount,
    scheduledCount: loaded.scheduledCount,
    lastEnded: loaded.lastEnded,
    endedThisWeek: loaded.endedThisWeek,
  };
}

export function shapeReport(report: Report) {
  return {
    today: report.today,
    evidence: report.evidence,
    goals: report.goals.map((goal) => {
      const unit = goal.unit;
      return {
        id: goal.id,
        name: goal.name,
        horizon: goal.horizon,
        endedOn: goal.endedOn,
        unit,
        thisMonth: shapeLine(goal.thisMonth, unit),
        toDate: { planned: amountOf(goal.toDate.planned, unit), reached: amountOf(goal.toDate.reached, unit) },
        phases: goal.phases.map((phase) => ({
          aim: phase.aim,
          startsOn: phase.startsOn,
          endsOn: phase.endsOn,
          current: phase.current,
        })),
        tasks: goal.tasks.map((task) => ({
          name: task.name,
          from: monthOrNull(task.from),
          done: task.done,
          doneOn: task.doneOn,
          estimate: amountOrNull(task.estimate, unit),
          owes: amountOf(task.owes, unit),
          hasAmount: task.hasAmount,
          note: task.note,
          children: task.children.map((child) => ({
            name: child.name,
            done: child.done,
            doneOn: child.doneOn,
            estimate: amountOrNull(child.estimate, unit),
            note: child.note,
          })),
        })),
        carried: goal.carried.map((item) => ({
          name: item.name,
          note: item.note,
          from: monthKey(item.from),
          owes: amountOf(item.owes, unit),
          hasAmount: item.hasAmount,
          children: item.children.map((child) => ({
            name: child.name,
            note: child.note,
            owes: amountOf(child.owes, unit),
            hasAmount: child.hasAmount,
          })),
        })),
        months: settledMonths(goal.months, goal.endedOn !== null).map((row) => ({
          month: monthKey(row.month),
          planned: amountOrNull(row.planned, unit),
          reached: amountOf(row.reached, unit),
          carriedPercent: row.carried,
          current: row.current,
          past: row.past,
        })),
        weeks: goal.weeks.map((week) => shapeWeek(week, unit)),
      };
    }),
  };
}

export function shapeLoose(input: { dayless: DaylessOneOff[]; scheduled: ScheduledOneOff[]; inGoals: GoalOneOff[] }) {
  const one = (oneOff: DaylessOneOff) => ({
    id: oneOff.id,
    name: oneOff.name,
    goalId: oneOff.goalId,
    goalName: oneOff.goalName,
    note: oneOff.note,
  });
  return {
    dayless: input.dayless.map(one),
    scheduled: input.scheduled.map((oneOff) => ({ ...one(oneOff), day: oneOff.day })),
    inGoals: input.inGoals.map((oneOff) => ({ ...one(oneOff), plannedMonth: oneOff.plannedMonth })),
  };
}
