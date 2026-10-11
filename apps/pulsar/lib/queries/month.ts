import "server-only";

import { sql } from "drizzle-orm";

import type { EvidenceDay } from "@/lib/day/types";
import { knownSourceKeys, readerFor } from "@/lib/evidence/registry";
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
import { toDeclaredFact } from "@/lib/queries/rows";
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
  plan: PlanInput;
};

// The screen's `MonthItem` plus what the plan says of the task: its part of
// the month, where it comes from and goes on to, whether it is fixed.
export type MonthAcrossItem = MonthItem &
  Pick<PlanItem, "hours" | "part" | "from" | "to" | "fixed" | "endsOn" | "pastEnd">;

export type MonthAcross = {
  month: string;
  today: string;
  evidence: "read" | "unreadable";
  goals: MonthAcrossGoal[];
};

type Row = {
  goal: GoalRow;
  commitments: CommitmentRow[];
  facts: FactRow[];
  budgets: { month: string; amount: number }[];
  tasks: PlanTaskRow[];
};

// What `to_jsonb(o)` already carries beyond the screens' `TaskRow`.
type PlanTaskRow = TaskRow & { in_plan: boolean; created_at: string; position: number };

// One statement over every goal open today. Facts are bounded in SQL to the
// month so a past month never reaches the process; tasks and budgets are not,
// since the plan fills from every task through every month of the goal. RLS narrows it to the caller (RNP-05).
async function queryRows(tx: Transaction, month: string, today: string): Promise<Row[]> {
  const rows = await tx.execute<Row>(sql`
    select
      to_jsonb(g) as goal,
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
    from "goals"."goals" g
    where g.archived_at is null
      and g.horizon > ${today}::date
      and (g.created_at at time zone ${TIME_ZONE})::date <= ${today}::date
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

  const goals = rows.map((row): MonthAcrossGoal => {
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
    const plan: PlanInput = {
      rhythm: row.goal.rhythm ?? null,
      budgets: row.budgets,
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
      const budget = row.budgets.find((entry) => entry.month === month) ?? null;
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

    return {
      id: row.goal.id,
      name: row.goal.name,
      unit,
      line,
      items: planMonthList(plan, month).map(
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
      ),
      open: true,
      plan,
    };
  });

  return { month, today, evidence: outcome.status === "read" ? "read" : "unreadable", goals };
}
