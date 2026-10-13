import "server-only";

import { sql } from "drizzle-orm";

import { askedIn } from "@/lib/day/habit-months";
import { habitWeeks, weeksOfMonth } from "@/lib/day/habit-weeks";
import type { Cadence, EvidenceDay } from "@/lib/day/types";
import { knownSourceKeys, readerFor } from "@/lib/evidence/registry";
import {
  branchOf,
  buildTree,
  rollUp,
  rootOf,
  type GoalMonths,
  type Level,
  type RolledUp,
  type Tree,
  type TreeRow,
} from "@/lib/goals/tree";
import { estimateFacts, type MonthItem } from "@/lib/plan/carry";
import { monthLine, monthOf, reachedByMonth, type MonthLine } from "@/lib/plan/months";
import { screenPlanned } from "@/lib/plan/screen-planned";
import { planMonthList } from "@/lib/plan/roadmap-read";
import type { PlanInput, PlanItem, PlanTask } from "@/lib/plan/roadmap";
import {
  evidenceDaysForMeasure,
  type CommitmentRow,
  type FactRow,
  type GoalRow,
  type TaskRow,
} from "@/lib/queries/goal";
import { toCadence, toDeclaredFact } from "@/lib/queries/rows";
import { getPerson, withGoalsDb, withReadingDb, type Transaction } from "@/lib/session";
import { civilDateInZone, TIME_ZONE, todayInZone } from "@/lib/zone";

export type MonthAcrossGoal = {
  id: string;
  name: string;
  unit: string | null;
  // Null when the goal measures nothing: its tasks draw with no amount.
  line: MonthLine | null;
  items: MonthAcrossItem[];
  open: boolean;
  // What the goal's tasks are placed from; the task sheet reads their plan month off it.
  // A goal that holds goals has no rhythm and no budgets of its own (RP-80).
  plan: PlanInput;
  // The goal above and the general at the top, for «de X»; the tree's place (RP-84).
  parentId: string | null;
  level: Level | null;
  rootId: string;
  rootName: string;
  aboveName: string | null;
  holdsGoals: boolean;
  // Goals under it that measure in another unit and add nothing to its line.
  outOfUnit: { id: string; name: string; unit: string }[];
};

// The screen's `MonthItem` plus what the plan says of the task: its part of
// the month, where it comes from and goes on to, whether it is fixed.
export type MonthAcrossItem = MonthItem &
  Pick<PlanItem, "hours" | "part" | "from" | "to" | "fixed" | "endsOn" | "pastEnd">;

export type MonthAcross = {
  month: string;
  today: string;
  evidence: "read" | "unreadable";
  // In the tree's order: each goal after the one above it.
  goals: MonthAcrossGoal[];
  // One entry per general (or lone goal); `goalIds` in preorder, drawn goals only.
  groups: { rootId: string; goalIds: string[] }[];
  // Habits with no goal (RP-100), live or retired this month, with the days of the month each was done.
  loose: MonthLooseHabit[];
};

// `asked` is how many days of the month through today the cadence asked on; null for a cadence counted by the week or the month.
// `weeks` is the weeks met of the weeks lived by the Thursday rule; null unless the cadence is counted by the week.
export type MonthLooseHabit = {
  id: string;
  name: string;
  daysDone: number;
  cadence: Cadence;
  asked: number | null;
  weeks: { met: number; counted: number } | null;
};

// `byWeek` holds the done days per Monday from the first week of the month, which can start in the month before.
type LooseRow = { id: string; name: string; daysDone: number; row: CommitmentRow; byWeek: { week: string; days: number }[] };

type Row = {
  // Null on the one row a person with no open goal gets, which still carries `loose`.
  goal: (GoalRow & { parent_id: string | null; position: number }) | null;
  loose: LooseRow[];
  commitments: CommitmentRow[];
  facts: FactRow[];
  budgets: { month: string; amount: number }[];
  tasks: PlanTaskRow[];
};

// What `to_jsonb(o)` already carries beyond the screens' `TaskRow`.
type PlanTaskRow = TaskRow & { in_plan: boolean; created_at: string; position: number };

// One statement over every goal open today. Facts are bounded in SQL to the
// month so a past month never reaches the process; tasks and budgets are not,
// since the plan fills from every task through every month of the goal. A goal that ended under
// an open goal is read too, for its part of the month's sum. RLS narrows it to the caller (RNP-05).
function looseHabit({ id, name, daysDone, row, byWeek }: LooseRow, month: string, today: string): MonthLooseHabit {
  const cadence = toCadence(row);
  const weeks =
    cadence.kind === "times_per_week"
      ? habitWeeks({
          count: cadence.count,
          createdOn: civilDateInZone(new Date(row.created_at)),
          retiredOn: row.retired_at ? civilDateInZone(new Date(row.retired_at)) : null,
          daysDoneByWeek: new Map(byWeek.map((entry) => [entry.week, entry.days])),
          month,
          today,
        })
      : null;
  const counted = cadence.kind === "daily" || cadence.kind === "weekdays" || cadence.kind === "every_n_days";
  if (!counted) return { id, name, daysDone, cadence, asked: null, weeks };
  const plan = { id, cadence, satisfiedBy: { kind: "tap" as const }, retiredAt: row.retired_at, createdOn: civilDateInZone(new Date(row.created_at)) };
  const asked = askedIn(plan, month, today);
  return { id, name, daysDone, cadence, asked, weeks };
}

async function queryRows(tx: Transaction, month: string, today: string): Promise<Row[]> {
  const weekFrom = weeksOfMonth(month)[0] ?? month;
  const rows = await tx.execute<Row>(sql`
    select
      to_jsonb(g) as goal,
      (select coalesce(json_agg(jsonb_build_object(
                 'id', h.id,
                 'name', h.name,
                 'row', to_jsonb(h),
                 'daysDone', (select count(distinct f.day)::int from "goals"."facts" f
                               where f.commitment_id = h.id and f.day between ${month}::date and ${today}::date),
                 'byWeek', (select coalesce(json_agg(jsonb_build_object('week', to_char(w.week, 'YYYY-MM-DD'), 'days', w.days)), '[]'::json)
                              from (select date_trunc('week', f.day)::date as week, count(distinct f.day)::int as days
                                      from "goals"."facts" f
                                     where f.commitment_id = h.id
                                       and f.day between ${weekFrom}::date and ${today}::date
                                     group by 1) w)
               ) order by h.position, h.created_at, h.id), '[]'::json)
         from "goals"."commitments" h
         where h.goal_id is null
           and (h.retired_at is null or (h.retired_at at time zone ${TIME_ZONE})::date >= ${month}::date)) as loose,
      (select coalesce(json_agg(to_jsonb(c) || jsonb_build_object(
                 'source_key', s.key,
                 'source_unit', s.unit,
                 'source_label_key', s.label_key
               ) order by c.position, c.created_at, c.id), '[]'::json)
         from "goals"."commitments" c
         left join "goals"."evidence_sources" s on s.id = c.source_id
         where c.goal_id = g.id) as commitments,
      (select coalesce(json_agg(to_jsonb(f) || jsonb_build_object(
                 'commitment_unit', c.unit
               )), '[]'::json)
         from "goals"."facts" f
         left join "goals"."commitments" c on c.id = f.commitment_id
         where f.goal_id = g.id
           and f.day between ${month}::date and ${today}::date) as facts,
      (select coalesce(json_agg(jsonb_build_object('month', b.month, 'amount', b.amount)
                                order by b.month), '[]'::json)
         from "goals"."month_budgets" b
         where b.goal_id = g.id) as budgets,
      (select coalesce(json_agg(to_jsonb(o) || jsonb_build_object(
                 'done_on', (select min(f.day) from "goals"."facts" f where f.one_off_id = o.id),
                 'fact_id', (select f.id from "goals"."facts" f where f.one_off_id = o.id
                             order by f.day, f.id limit 1)
               ) order by o.position, o.created_at, o.id), '[]'::json)
         from "goals"."one_offs" o where o.goal_id = g.id) as tasks
    from (select 1) one
    left join "goals"."goals" g
      on g.archived_at is null
      and (g.created_at at time zone ${TIME_ZONE})::date <= ${today}::date
      and (g.horizon is null or g.horizon > ${today}::date
        or exists (
          select 1 from "goals"."goals" a
          where a.archived_at is null
            and (a.horizon is null or a.horizon > ${today}::date)
            and a.id in (g.parent_id, (select pp.parent_id from "goals"."goals" pp where pp.id = g.parent_id))
        ))
    order by g.position, g.created_at, g.id
  `);
  return [...rows];
}

async function queryEvidence(
  tx: Transaction,
  personId: string,
  month: string,
  today: string,
): Promise<Record<string, EvidenceDay[]>> {
  const bySourceKey: Record<string, EvidenceDay[]> = {};
  for (const key of knownSourceKeys()) {
    const reader = readerFor(key);
    if (!reader) continue;
    bySourceKey[key] = await reader({ personId, from: month, to: today, zone: TIME_ZONE, tx });
  }
  return bySourceKey;
}

/**
 * «Mes» across every open goal (RP-43): each goal's month figure and list as
 * its own screen reads them, in two transactions fanned with `Promise.all`
 * whatever the goal count (RNP-03). An evidence rejection degrades to
 * `"unreadable"` and every goal keeps its declared half (RNP-04). Writes nothing.
 */
export async function loadMonthAcross(today: string = todayInZone()): Promise<MonthAcross> {
  const person = await getPerson();
  if (!person) throw new Error("loadMonthAcross called without a verified session");

  const month = monthOf(today);
  const [rows, outcome] = await Promise.all([
    withGoalsDb((tx) => queryRows(tx, month, today)),
    withReadingDb((tx) => queryEvidence(tx, person.id, month, today)).then(
      (bySourceKey) => ({ status: "read" as const, bySourceKey }),
      () => ({ status: "unreadable" as const, bySourceKey: {} as Record<string, EvidenceDay[]> }),
    ),
  ]);

  const loose = (rows[0]?.loose ?? []).map((habit) => looseHabit(habit, month, today));
  const goalRows = rows.filter((row): row is Row & { goal: NonNullable<Row["goal"]> } => row.goal !== null);
  const tree = buildTree(goalRows.map(treeRowOf));
  const holders = new Set(tree.order.filter((node) => node.children.length > 0).map((node) => node.id));

  const built = goalRows.map((row) => {
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
    const holds = holders.has(row.goal.id);
    const plan: PlanInput = {
      rhythm: holds ? null : (row.goal.rhythm ?? null),
      budgets: holds ? [] : row.budgets,
      tasks,
      openedOn: civilDateInZone(new Date(row.goal.created_at)),
      horizon: row.goal.horizon,
      today,
    };
    const unit = row.goal.measure_unit;

    let line: MonthLine | null = null;
    if (unit !== null) {
      const declared = row.facts
        .filter((fact): fact is FactRow & { commitment_id: string } => fact.commitment_id !== null)
        .map(toDeclaredFact);
      // Done tasks of earlier months stay out: only this month's reach counts.
      const doneTasks = estimateFacts(tasks, unit).filter((fact) => monthOf(fact.day) === month);
      const evidence =
        outcome.status === "read" ? evidenceDaysForMeasure(row.goal, row.commitments, outcome.bySourceKey) : [];
      // Every fact and evidence day the statements returned is already this month's.
      let reached = 0;
      for (const amount of reachedByMonth({ unit, facts: [...declared, ...doneTasks], evidence }).values()) {
        reached += amount;
      }
      const budget = holds ? null : (row.budgets.find((entry) => entry.month === month) ?? null);
      const raw = monthLine({
        month,
        today,
        budget,
        reached,
        rhythm: plan.rhythm,
        openedOn: plan.openedOn,
        horizon: plan.horizon,
      });
      line = { ...raw, planned: screenPlanned(raw.planned, budget !== null) };
    }

    const items = planMonthList(plan, month).map(
      (item): MonthAcrossItem => ({
        task: item.task,
        children: item.children,
        carriedFrom: item.carriedFrom,
        owes: item.part,
        hasAmount:
          item.children.length === 0
            ? item.task.estimate !== null
            : item.children.some((child) => child.estimate !== null),
        done: item.done,
        hours: item.hours,
        part: item.part,
        from: item.from,
        to: item.to,
        fixed: item.fixed,
        endsOn: item.endsOn,
        pastEnd: item.pastEnd,
      }),
    );
    return { row, unit, line, items, plan };
  });

  // Each goal's own month figure feeds the sum of the one above it (RP-80).
  const own = new Map<string, GoalMonths>();
  for (const { row, unit, line } of built) {
    if (unit === null || line === null) continue;
    own.set(row.goal.id, {
      unit,
      months: new Map([[month, { planned: line.planned, reached: line.reached, ownBudget: false }]]),
    });
  }
  const rolled = rollUp(tree, own);

  const open = (row: { goal: { horizon: string | null } }): boolean => row.goal.horizon === null || row.goal.horizon > today;
  const goals = built.filter(({ row }) => open(row)).map(({ row, unit, line, items, plan }): MonthAcrossGoal => {
    const id = row.goal.id;
    const sum = rolled.get(id);
    return {
      id,
      name: row.goal.name,
      unit: sum ? sum.unit : unit,
      line: sum ? lineOfSum(sum, month, today, plan) : line,
      items,
      open: true,
      plan,
      ...placeOf(tree, id),
      holdsGoals: sum !== undefined,
      outOfUnit: sum?.outOfUnit ?? [],
    };
  });
  const order = new Map(tree.order.map((node, index) => [node.id, index]));
  goals.sort((a, b) => order.get(a.id)! - order.get(b.id)!);

  const drawn = new Set(goals.map((goal) => goal.id));
  const groups = tree.order
    .filter((node) => node.depth === 0)
    .map((node) => ({ rootId: node.id, goalIds: branchOf(tree, node.id).filter((id) => drawn.has(id)) }))
    .filter((group) => group.goalIds.length > 0);

  return { month, today, evidence: outcome.status === "read" ? "read" : "unreadable", goals, groups, loose };
}

function treeRowOf(row: Row & { goal: NonNullable<Row["goal"]> }): TreeRow {
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

// Where a goal sits: the goal above it and the general at the top, by name.
export function placeOf(tree: Tree, id: string) {
  const node = tree.byId.get(id)!;
  const rootId = rootOf(tree, id);
  return {
    parentId: node.ancestors[0] ?? null,
    level: node.level,
    rootId,
    rootName: tree.byId.get(rootId)!.name,
    aboveName: node.ancestors[0] ? tree.byId.get(node.ancestors[0])!.name : null,
  };
}

// A holder's line: the sums of its goals' this month, with its own pace.
function lineOfSum(sum: RolledUp, month: string, today: string, plan: PlanInput): MonthLine | null {
  if (sum.unit === null) return null;
  const figure = sum.months.get(month);
  const planned = figure?.planned ?? null;
  const reached = figure?.reached ?? 0;
  const { underPace } = monthLine({
    month,
    today,
    budget: planned === null ? null : { month, amount: planned },
    reached,
    openedOn: plan.openedOn,
    horizon: plan.horizon,
  });
  return { planned, reached, underPace };
}
