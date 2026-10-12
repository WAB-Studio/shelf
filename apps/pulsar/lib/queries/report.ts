import "server-only";

import { sql } from "drizzle-orm";

import { phaseOn } from "@/lib/day/derive";
import type { EvidenceDay, Phase, ReviewWeek } from "@/lib/day/types";
import { measureByWeek } from "@/lib/day/review";
import { dayBefore } from "@/lib/day/weeks";
import { branchOf, buildTree, rollUp, spanStart, type GoalMonths, type RolledUp, type Tree, type TreeRow } from "@/lib/goals/tree";
import { queryEvidenceBySource } from "@/lib/queries/evidence";
import type { GoalReport, Report, ReportTask } from "@/lib/export/report";
import { monthLine, monthOf, monthsOfSpan, toDate } from "@/lib/plan/months";
import type { PlanInput, PlanItem, PlanTask } from "@/lib/plan/roadmap";
import { planMonthList, planShare } from "@/lib/plan/roadmap-read";
import { weekPlanned } from "@/lib/plan/week-planned";
import {
  goalFigures,
  matchingSourceKeys,
  type CommitmentRow,
  type FactRow,
  type GoalRow,
  type TaskRow,
} from "@/lib/queries/goal";
import { placeOf } from "@/lib/queries/month";
import { toPhase, type PhaseRow } from "@/lib/queries/rows";
import { getPerson, withGoalsDb, withReadingDb, type Transaction } from "@/lib/session";
import { isTimeUnit } from "@/lib/units/time";
import { civilDateInZone, TIME_ZONE, todayInZone } from "@/lib/zone";

// One row per open goal, each carrying what `queryGoalRow` (`goal.ts`) reads
// for a single one.
type ReportRow = {
  goal: GoalRow & { parent_id: string | null; position: number };
  phases: PhaseRow[];
  commitments: CommitmentRow[];
  facts: FactRow[];
  budgets: { month: string; amount: number }[];
  tasks: (TaskRow & { in_plan: boolean; created_at: string; position: number })[];
};

// One statement over every goal not archived (RP-49). RLS narrows it to the
// caller's own rows (RNP-05).
async function queryReportRows(tx: Transaction): Promise<ReportRow[]> {
  const rows = await tx.execute<ReportRow>(sql`
    select
      to_jsonb(g) as goal,
      (select coalesce(json_agg(to_jsonb(p)), '[]'::json)
         from "goals"."phases" p where p.goal_id = g.id) as phases,
      (select coalesce(json_agg(to_jsonb(c) || jsonb_build_object(
                 'source_key', s.key,
                 'source_unit', s.unit,
                 'source_label_key', s.label_key
               )), '[]'::json)
         from "goals"."commitments" c
         left join "goals"."evidence_sources" s on s.id = c.source_id
         where c.goal_id = g.id) as commitments,
      (select coalesce(json_agg(to_jsonb(f) || jsonb_build_object(
                 'commitment_unit', c.unit
               )), '[]'::json)
         from "goals"."facts" f
         left join "goals"."commitments" c on c.id = f.commitment_id
         where f.goal_id = g.id) as facts,
      (select coalesce(json_agg(jsonb_build_object('month', b.month, 'amount', b.amount)
                                order by b.month), '[]'::json)
         from "goals"."month_budgets" b where b.goal_id = g.id) as budgets,
      (select coalesce(json_agg(to_jsonb(o) || jsonb_build_object(
                 'done_on', (select min(f.day) from "goals"."facts" f where f.one_off_id = o.id)
               ) order by o.position, o.created_at, o.id), '[]'::json)
         from "goals"."one_offs" o where o.goal_id = g.id) as tasks
    from "goals"."goals" g
    where g.archived_at is null
    order by g.position, g.created_at, g.id
  `);
  return [...rows];
}

// Bounded in SQL from the earliest open goal's opening, as `goalSpan` does
// for one goal: the reading statement opens blind, beside the goals one.
const reportEvidenceFrom = sql`(select min((g.created_at at time zone ${TIME_ZONE})::date)
                      from "goals"."goals" g where g.archived_at is null)`;

// The goal's plan, read the way `planMonthList` and `planShare` ask (RP-49).
// A goal that holds goals has no rhythm and no budgets of its own (RP-80).
function planInputOf(row: ReportRow, today: string, holds: boolean): PlanInput {
  const tasks: PlanTask[] = row.tasks.map((task) => ({
    id: task.id,
    parentId: task.parent_id,
    name: task.name,
    plannedMonth: task.planned_month,
    day: task.day,
    estimate: task.estimate,
    doneOn: task.done_on,
    factId: task.fact_id ?? null,
    note: task.note,
    inPlan: task.in_plan,
    createdOn: civilDateInZone(new Date(task.created_at)),
    position: task.position,
  }));
  return {
    rhythm: holds ? null : (row.goal.rhythm ?? null),
    budgets: holds ? [] : row.budgets,
    tasks,
    openedOn: civilDateInZone(new Date(row.goal.created_at)),
    horizon: row.goal.horizon,
    today,
  };
}

// False when neither the task nor any child carries an estimate.
function hasAmountOf(item: PlanItem): boolean {
  return item.children.length === 0
    ? item.task.estimate !== null
    : item.children.some((child) => child.estimate !== null);
}

// What the plan hands «Mes», done and not (RP-49). A parent is done on its
// last child's day; `owes` counts what is undone today.
function toReportTask(item: PlanItem): ReportTask {
  const leaf = item.children.length === 0;
  const splits = item.from !== null || item.to !== null;
  const undone = item.children.filter((child) => child.doneOn === null);
  const doneOn = !item.done
    ? null
    : leaf
      ? item.task.doneOn
      : item.children.reduce<string | null>(
          (last, child) => (last === null || (child.doneOn ?? "") > last ? child.doneOn : last),
          null,
        );
  return {
    name: item.task.name,
    from: item.carriedFrom,
    done: item.done,
    doneOn,
    estimate: leaf ? item.task.estimate : null,
    part: splits && hasAmountOf(item) ? item.part : null,
    continuesIn: item.to,
    owes: leaf
      ? item.task.doneOn === null
        ? (item.task.estimate ?? 0)
        : 0
      : undone.reduce((sum, child) => sum + (child.estimate ?? 0), 0),
    hasAmount: hasAmountOf(item),
    note: item.task.note ?? null,
    children: item.children.map((child) => ({
      name: child.name,
      done: child.doneOn !== null,
      doneOn: child.doneOn,
      estimate: child.estimate,
      note: child.note ?? null,
    })),
  };
}

// The days `loadGoal` would have read: its own opening to the day before its horizon.
function withinGoal(
  bySourceKey: Record<string, EvidenceDay[]>,
  openedOn: string,
  horizon: string,
): Record<string, EvidenceDay[]> {
  const bounded: Record<string, EvidenceDay[]> = {};
  for (const [key, days] of Object.entries(bySourceKey)) {
    bounded[key] = days.filter((day) => day.day >= openedOn && day.day < horizon);
  }
  return bounded;
}

/**
 * The export's data (RP-49): every goal not archived, in two transactions
 * fanned with `Promise.all` — one over the goals, one over the evidence — so
 * the goal count never lengthens the chain (RNP-03). An evidence rejection
 * degrades to `"unreadable"` and every goal keeps its declared half (RNP-04).
 */
export async function loadReport(today: string = todayInZone()): Promise<Report> {
  const person = await getPerson();
  if (!person) throw new Error("loadReport called without a verified session");

  const [rows, evidenceOutcome] = await Promise.all([
    withGoalsDb(queryReportRows),
    withReadingDb((tx) => queryEvidenceBySource(tx, person.id, reportEvidenceFrom, today)).then(
      (bySourceKey) => ({ status: "read" as const, bySourceKey }),
      () => ({ status: "unreadable" as const, bySourceKey: {} }),
    ),
  ]);

  const thisMonth = monthOf(today);
  const tree = buildTree(rows.map(treeRowOf));
  const holders = new Set(tree.order.filter((node) => node.children.length > 0).map((node) => node.id));
  const built = rows.map((row) => {
    const phases = row.phases.map(toPhase);
    const openedOn = civilDateInZone(new Date(row.goal.created_at));
    const figures = goalFigures({
      goal: row.goal,
      phases,
      commitments: row.commitments,
      facts: row.facts,
      budgets: row.budgets,
      tasks: row.tasks,
      evidence:
        evidenceOutcome.status === "read"
          ? withinGoal(evidenceOutcome.bySourceKey, openedOn, row.goal.horizon)
          : null,
      today,
    });
    const current = phaseOn(phases, today);
    const planInput = planInputOf(row, today, holders.has(row.goal.id));
    const monthItems = planMonthList(planInput, thisMonth);
    // A time goal with no rhythm has no amount to read a month by, so it reads tasks.
    const unit = row.goal.measure_unit;
    const countsTasks = unit === null || (isTimeUnit(unit) && (row.goal.rhythm ?? null) === null);

    const report: GoalReport = {
      id: row.goal.id,
      name: row.goal.name,
      horizon: row.goal.horizon,
      endedOn: row.goal.horizon <= today ? dayBefore(row.goal.horizon) : null,
      unit: row.goal.measure_unit,
      measureName: row.goal.measure_name,
      note: row.goal.note ?? null,
      measureFed: matchingSourceKeys(row.goal, row.commitments).size > 0,
      thisMonth: {
        planned: figures.month?.planned ?? null,
        reached: figures.month?.reached ?? 0,
        underPace: figures.month?.underPace ?? false,
      },
      toDate: toDate(figures.months),
      ownMonths: row.budgets.map((budget) => budget.month),
      phases: phases.map((phase) => ({
        aim: phase.name,
        startsOn: phase.startsOn,
        endsOn: phase.endsOn,
        current: current?.id === phase.id,
      })),
      tasks: monthItems.map(toReportTask),
      carried: monthItems
        .filter((item) => item.carriedFrom !== null && !item.done)
        .map((item) => {
          // Only what is undone today: a child done this month owes nothing.
          const children = item.children
            .filter((child) => child.doneOn === null)
            .map((child) => ({
              name: child.name,
              note: child.note ?? null,
              owes: child.estimate ?? 0,
              hasAmount: child.estimate !== null,
            }));
          const leaf = item.children.length === 0;
          return {
            name: item.task.name,
            note: item.task.note ?? null,
            from: item.carriedFrom as string,
            owes: leaf ? (item.task.estimate ?? 0) : children.reduce((sum, c) => sum + c.owes, 0),
            hasAmount: hasAmountOf(item),
            children,
          };
        }),
      months: figures.months.map((row) => {
        const share = row.past ? planShare(planInput, row.month) : null;
        const items = countsTasks ? planMonthList(planInput, row.month) : null;
        return {
          ...row,
          carried: share && share.carried > 0 ? Math.floor((share.carried * 100) / share.planned) : null,
          ...(items ? { tasks: { done: items.filter((item) => item.done).length, total: items.length } } : {}),
        };
      }),
      weeks: figures.weeks,
      weekPlanned: (() => {
        const week = figures.weeks.find((w) => w.current);
        return week
          ? weekPlanned({
              weekStart: week.startsOn,
              weekEnd: week.endsOn,
              budgets: row.budgets,
              openedOn,
              horizon: row.goal.horizon,
              rhythm: row.goal.rhythm ?? null,
            })
          : null;
      })(),
      weekSplits: weekSplitsOf(figures.weeks, figures.totalInSpan),
    };
    return { report, figures, row, phases, planInput };
  });

  // Each goal's own months feed the sum of the one above it (RP-80).
  const own = new Map<string, GoalMonths>();
  for (const { row, figures } of built) {
    if (row.goal.measure_unit === null) continue;
    const typed = new Set(row.budgets.map((budget) => budget.month));
    own.set(row.goal.id, {
      unit: row.goal.measure_unit,
      months: new Map(
        figures.months.map((m) => [m.month, { planned: m.planned, reached: m.reached, ownBudget: typed.has(m.month) }]),
      ),
    });
  }
  const rolled = rollUp(tree, own);

  const byId = new Map(built.map((entry) => [entry.row.goal.id, entry]));
  const reports = new Map<string, GoalReport>();
  // Bottom-up, so a holder reads its goals' week amounts once they hold their own.
  for (const { report, row, phases } of [...built].reverse()) {
    const id = row.goal.id;
    const sum = rolled.get(id);
    reports.set(id, {
      ...(sum ? holderOf({ report, sum, thisMonth, today, row, phases, tree, rolled, byId, reports }) : report),
      ...placeOf(tree, id),
      holdsGoals: sum !== undefined,
      outOfUnit: sum?.outOfUnit ?? [],
    });
  }
  const order = new Map(tree.order.map((node, index) => [node.id, index]));
  const goals = [...reports.values()].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const groups = tree.order
    .filter((node) => node.depth === 0)
    .map((node) => ({ rootId: node.id, goalIds: branchOf(tree, node.id) }));

  return { today, evidence: evidenceOutcome.status === "read" ? "read" : "unreadable", goals, groups };
}

function treeRowOf(row: ReportRow): TreeRow {
  return {
    id: row.goal.id,
    parentId: row.goal.parent_id,
    position: row.goal.position,
    createdAt: row.goal.created_at,
    name: row.goal.name,
    horizon: row.goal.horizon,
    archivedAt: row.goal.archived_at,
    measureUnit: row.goal.measure_unit,
  };
}

// A week crossing two months, cut at the month's edge (RP-17).
function weekSplitsOf(
  weeks: ReviewWeek[],
  total: (startsOn: string, endsOn: string) => number,
): GoalReport["weekSplits"] {
  return weeks
    .filter((week) => monthOf(week.startsOn) !== monthOf(week.endsOn))
    .flatMap((week) => {
      const secondMonth = monthOf(week.endsOn);
      const parts = [
        { month: monthOf(week.startsOn), startsOn: week.startsOn, endsOn: dayBefore(secondMonth) },
        { month: secondMonth, startsOn: secondMonth, endsOn: week.endsOn },
      ];
      return parts.map((part) => ({ index: week.index, ...part, total: total(part.startsOn, part.endsOn) }));
    });
}

type Built = {
  row: ReportRow;
  figures: ReturnType<typeof goalFigures>;
  planInput: PlanInput;
};

// A goal that holds goals reads its months, this month, its weeks and its task
// counts off the sums of its goals plus its own (RP-80, P3 = B); it has no
// week amount of its own, only theirs.
function holderOf(args: {
  report: GoalReport;
  sum: RolledUp;
  thisMonth: string;
  today: string;
  row: ReportRow;
  phases: Phase[];
  tree: Tree;
  rolled: Map<string, RolledUp>;
  byId: Map<string, Built>;
  reports: Map<string, GoalReport>;
}): GoalReport {
  const { report, sum, thisMonth, today, row, phases, tree, rolled, byId, reports } = args;
  const id = row.goal.id;
  const node = tree.byId.get(id)!;
  const unitOf = (goalId: string): string | null => rolled.get(goalId)?.unit ?? byId.get(goalId)!.row.goal.measure_unit;

  // Its own plus every goal under it in its unit.
  const spanTotal = (goalId: string, startsOn: string, endsOn: string): number => {
    const unit = unitOf(goalId);
    if (unit === null) return 0;
    const entry = byId.get(goalId)!;
    const ownUnit = entry.row.goal.measure_unit;
    let total = ownUnit === null || ownUnit === unit ? entry.figures.totalInSpan(startsOn, endsOn) : 0;
    for (const cid of tree.byId.get(goalId)!.children) {
      if (unitOf(cid) === unit) total += spanTotal(cid, startsOn, endsOn);
    }
    return total;
  };
  const spanStartOn = spanStart(tree, id);
  const weeks = measureByWeek({
    openedOn: spanStartOn,
    horizon: row.goal.horizon,
    today,
    unit: null,
    facts: [],
    evidence: [],
    phases,
  }).map((week) => ({ ...week, total: spanTotal(id, week.startsOn, week.endsOn) }));

  const weekPlanned = node.children
    .map((cid) => reports.get(cid))
    .filter((child) => child !== undefined && child.weekPlanned != null && child.unit === sum.unit)
    .reduce<number | null>((total, child) => (total ?? 0) + child!.weekPlanned!, null);

  // Its months open where its first goal's do, which can be before its own opening.
  const current = monthOf(today);
  const kept = new Map(report.months.map((m) => [m.month, m]));
  const branch = branchOf(tree, id);
  const countsTasks = sum.unit === null || isTimeUnit(sum.unit);
  const months = monthsOfSpan(spanStartOn, row.goal.horizon).map((month) => {
    const figure = sum.months.get(month);
    const old = kept.get(month);
    const items = countsTasks ? branch.flatMap((goalId) => planMonthList(byId.get(goalId)!.planInput, month)) : null;
    return {
      month,
      planned: figure?.planned ?? null,
      reached: figure?.reached ?? 0,
      current: month === current,
      past: month < current,
      carried: old?.carried ?? null,
      ...(items ? { tasks: { done: items.filter((item) => item.done).length, total: items.length } } : {}),
    };
  });
  const figure = sum.months.get(thisMonth);
  const planned = figure?.planned ?? null;
  const reached = figure?.reached ?? 0;
  const { underPace } = monthLine({
    month: thisMonth,
    today,
    budget: planned === null ? null : { month: thisMonth, amount: planned },
    reached,
    openedOn: civilDateInZone(new Date(row.goal.created_at)),
    horizon: row.goal.horizon,
  });
  return {
    ...report,
    unit: sum.unit,
    thisMonth: { planned, reached, underPace },
    toDate: toDate(months),
    months,
    weeks,
    weekSplits: weekSplitsOf(weeks, (startsOn, endsOn) => spanTotal(id, startsOn, endsOn)),
    weekPlanned: sum.unit === null ? null : weekPlanned,
  };
}
