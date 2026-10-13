import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { cache } from "react";
import { z } from "zod";

import { measureOf } from "@/lib/day/derive";
import { evidenceDaysFor } from "@/lib/day/measure-inputs";
import { measureByWeek, totalInSpan } from "@/lib/day/review";
import type { Cadence, EvidenceDay, Phase, ReviewWeek, SatisfiedBy } from "@/lib/day/types";
import {
  toCadence,
  toDeclaredFact,
  toPhase,
  toSatisfiedBy,
  type CommitmentRow as BaseCommitmentRow,
  type PhaseRow,
} from "@/lib/queries/rows";
import { readEvidenceOutcome } from "@/lib/queries/day";
import { queryEvidenceBySource } from "@/lib/queries/evidence";
import type { EvidenceOutcome } from "@/lib/queries/evidence";
import { getPerson, withGoalsDb, withReadingDb, type Transaction } from "@/lib/session";
import { civilDateInZone, TIME_ZONE, todayInZone } from "@/lib/zone";
import { dayBefore } from "@/lib/day/weeks";
import { estimateFacts } from "@/lib/plan/carry";
import { fillPlan, type PlanInput, type PlanTask, type Roadmap } from "@/lib/plan/roadmap";
import { planMonthList } from "@/lib/plan/roadmap-read";
import {
  monthLine,
  monthOf,
  monthRows,
  monthsOfSpan,
  plannedOf,
  reachedByMonth,
  type MonthBudget,
  type MonthRow,
} from "@/lib/plan/months";
import { screenPlanned } from "@/lib/plan/screen-planned";
import { sourceKey, type SourceKey } from "@/i18n/translator";
import {
  branchOf,
  buildTree,
  rollUp,
  spanStart,
  type GoalMonths,
  type Level,
  type MonthFigure,
  type RolledUp,
  type TreeNode,
  type TreeRow,
} from "@/lib/goals/tree";

// `withReadingDb`'s query fans out over `knownSourceKeys()`
// (`lib/evidence/registry.ts`), for the same reason `lib/queries/day.ts` and
// `lib/queries/week.ts` do: which source a goal's commitments actually name
// is only known once the goals query resolves, and waiting on that would
// turn this file's own `Promise.all` into the chain RNP-03 forbids.

export type GoalRow = {
  id: string;
  name: string;
  // Null: a goal with no end (RP-99).
  horizon: string | null;
  measure_name: string | null;
  measure_unit: string | null;
  created_at: string;
  // Null while open, set once by `archiveGoal` (RP-24). `listGoals`'s own
  // raw select and `queryGoalRow`'s `to_jsonb(g)` both fill it, so one type
  // covers a single goal and a list of them alike.
  archived_at: string | null;
  // Optional so a caller that builds a row by hand keeps compiling; both ride
  // in on `to_jsonb(g)`.
  rhythm?: number | null;
  plan_seen?: string | null;
  // Both ride in on `to_jsonb(g)`; `listGoalsForMetas` names them.
  parent_id?: string | null;
  note?: string | null;
};

export type GoalRef = { id: string; name: string; horizon: string | null };

// `source_key`, `source_unit` and `source_label_key` ride in from the join to
// `evidence_sources`. `source_key` feeds `evidenceMeasureTotal` below, the
// same way `lib/queries/day.ts`'s own `source_key` feeds its per-commitment
// mapping; `source_label_key` widens `rows.ts`'s own `CommitmentRow` and is
// what lets the screen say which source an evidence commitment names (RP-09)
// — a catalogue key, never a sentence (RNP-01).
export type CommitmentRow = BaseCommitmentRow & { source_label_key: string | null };

// `commitment_unit` rides in from the join to `commitments`: a fact carries a
// bare quantity, never its own unit.
export type FactRow = {
  commitment_id: string | null;
  day: string;
  written_at: string;
  quantity: number | null;
  note: string | null;
  commitment_unit: string | null;
};

// One statement's whole shape: the goal itself (`null` when the id does not
// resolve under RLS — deleted, or somebody else's), every phase and every
// commitment it has ever had, and every fact that names it — retired
// commitments and old facts included, since a goal's screen never hides what
// it once asked for (RP-13).
type GoalQueryRow = {
  goal: GoalRow | null;
  phases: PhaseRow[];
  commitments: CommitmentRow[];
  facts: FactRow[];
  budgets: { month: string; amount: number }[];
  tasks: TaskRow[];
  // Every goal the person has, for the tree around this one.
  tree: TreeSqlRow[];
  // The non-archived goals under this one, at any depth, each with what the
  // statement above reads for the goal itself.
  branch: BranchEntry[];
};

type TreeSqlRow = {
  id: string;
  name: string;
  parent_id: string | null;
  position: number;
  created_at: string;
  horizon: string | null;
  archived_at: string | null;
  measure_unit: string | null;
};

type BranchEntry = {
  goal: GoalRow;
  commitments: CommitmentRow[];
  facts: FactRow[];
  budgets: { month: string; amount: number }[];
  tasks: TaskRow[];
};

function toTreeRow(row: TreeSqlRow): TreeRow {
  return {
    id: row.id,
    parentId: row.parent_id,
    position: row.position,
    createdAt: row.created_at,
    name: row.name,
    horizon: row.horizon,
    archivedAt: row.archived_at,
    measureUnit: row.measure_unit,
  };
}

const TREE_COLUMNS = sql`jsonb_build_object(
  'id', g.id, 'name', g.name, 'parent_id', g.parent_id, 'position', g.position,
  'created_at', g.created_at, 'horizon', g.horizon, 'archived_at', g.archived_at,
  'measure_unit', g.measure_unit)`;

// A one-off of the goal; `done_on` is the day of its own fact, null while
// undone.
export type TaskRow = {
  id: string;
  parent_id: string | null;
  name: string;
  planned_month: string | null;
  day: string | null;
  estimate: number | null;
  done_on: string | null;
  // The id of its own fact, what `undoFact` takes back; null while undone.
  fact_id?: string | null;
  note: string | null;
  // All three ride in on `to_jsonb(o)`.
  in_plan?: boolean;
  position?: number;
  created_at?: string;
};

// What a commitment reads as on the goal's own screen: its cadence and what
// satisfies it, in the engine's own shapes, plus its name and its retirement
// — drawn, never hidden (RP-13). A view of its own rather than
// `CommitmentPlan`: the goal's screen has no day to ask `asksOn` against.
export type GoalCommitment = {
  id: string;
  name: string;
  cadence: Cadence;
  satisfiedBy: SatisfiedBy;
  retiredAt: string | null;
  // The evidence source's own catalogue key (RNP-01), set only when
  // `satisfiedBy.kind === "evidence"` — the goal's screen reads the source's
  // name from `sources.json` under this key, never a sentence stored here.
  sourceLabelKey: SourceKey | null;
  // Distinct days this commitment has a declared fact on (the retire
  // sheet: "los N días en que lo hiciste" — RP-13 says the days already done
  // stay done). Counted here, off `row.facts` the goal statement already
  // carries whole, never a second round trip and never a subselect: an
  // evidence-satisfied commitment writes no fact of its own (RP-05), so this
  // is 0 for one and the screen drops the clause rather than say "0 días".
  factDayCount: number;
};

export type GoalView = {
  id: string;
  name: string;
  horizon: string | null;
  // The last day the goal counted: `dayBefore(horizon)` once `horizon` is
  // today or past, null while it still runs and for a goal with no end. Archived or not — the screen
  // decides which wins.
  endedOn: string | null;
  // When the goal was opened (§0.3, 3), in the person's own zone — the goal
  // screen's own overline (RP-11), read off `to_jsonb(g)`'s whole row rather
  // than a second round trip.
  createdAt: string;
  measureName: string | null;
  measureUnit: string | null;
  // Null while open, set once the moment `archiveGoal` runs (RP-24): what
  // the goal's own screen reads to draw «Reabrir» in place of «Archivar esta
  // meta» and to drop its add-commitment / add-phase ways in.
  archivedAt: string | null;
  // A sum over facts, computed here and never read from a column (RP-14):
  // `goals.goals` has no place to hold one, and the grant layer refuses a
  // write to any column that would.
  measureTotal: number;
  phases: Phase[];
  commitments: GoalCommitment[];
  // The measure read week by week, from the goal's own opening to the week
  // holding today (RP-17) — `measureByWeek` (`lib/day/review.ts`), run over
  // the same declared facts and evidence days `measureTotal` above sums.
  // Evidence `"unreadable"` still fills this: `loadGoal` hands `measureByWeek`
  // an empty evidence list in that case (RNP-04), so a week reads its
  // declared half alone rather than going missing.
  weeks: ReviewWeek[];
  // Whether the second transaction — another app's own rows — could be read
  // this time (RNP-04). `measureTotal` above is still the goal's real total
  // when this reads `"unreadable"`: it is the declared half alone, never a
  // blank goal and never an error page.
  evidence: "read" | "unreadable";
  // The current month's line (RP-29); null without a measure or when today
  // sits outside the goal's span.
  month: { month: string; planned: number | null; reached: number; underPace: boolean } | null;
  // Every month of the span, a month with nothing included (RP-16).
  months: MonthRow[];
  budgets: MonthBudget[];
  tasks: PlanTask[];
  // Units a month the person plans at (RP-52); null falls back to the budgets.
  rhythm: number | null;
  // The month whose notice the person dismissed (RP-53).
  planSeen: string | null;
  // What the plan reads: the tasks, the amounts and the span, as of `today`.
  plan: PlanInput;
  roadmap: Roadmap;
  note: string | null;
  // The goal above and the ones above that, the top one first.
  parent: GoalRef | null;
  ancestors: GoalRef[];
  // Null for a goal with no goal above and none under it.
  level: Level | null;
  holdsGoals: boolean;
  // The goals directly under, in order; `month` is the current one.
  children: {
    id: string;
    name: string;
    level: Level;
    unit: string | null;
    inUnit: boolean;
    month: { planned: number | null; reached: number } | null;
    // The first month from now on that the goal plans an amount in: «El plan» of a goal holding goals.
    firstPlanned: { month: string; planned: number } | null;
    endedOn: string | null;
    archivedAt: string | null;
  }[];
  // Goals under it measured in another unit, which add nothing to its sums.
  outOfUnit: { id: string; name: string; unit: string }[];
  // Non-archived goals anywhere under it (RP-83).
  branchOpenCount: number;
  // The goal under it that ends last, the ceiling of its own end (RP-79).
  latestBelow: GoalRef | null;
  above: GoalRef | null;
  tree: TreeNode[];
};

// A one-off as the plan reads it. A row without `created_at` counts as made
// the day the goal opened.
function toPlanTask(task: TaskRow, openedOn: string): PlanTask {
  return {
    id: task.id,
    parentId: task.parent_id,
    name: task.name,
    plannedMonth: task.planned_month,
    day: task.day,
    estimate: task.estimate,
    doneOn: task.done_on,
    factId: task.fact_id ?? null,
    note: task.note,
    inPlan: task.in_plan ?? false,
    position: task.position ?? 0,
    createdOn: task.created_at ? civilDateInZone(new Date(task.created_at)) : openedOn,
  };
}

export type GoalSummary = {
  id: string;
  name: string;
  horizon: string | null;
  measureName: string | null;
  measureUnit: string | null;
  archivedAt: string | null;
};

/**
 * One statement, eight subqueries: the goal row scoped by id, and every phase,
 * commitment, fact, month budget, one-off that name it — unfiltered by `retired_at` or by day, so
 * a goal's screen reads its whole history in the one round trip — then the
 * person's whole tree and the same rows for each non-archived goal under it. RLS alone
 * narrows every row to the caller's own (RNP-05); `goalId` alone would let a
 * caller read a goal id they merely guessed, so `goal` still comes back
 * `null` when it is not theirs.
 */
async function queryGoalRow(tx: Transaction, goalId: string): Promise<GoalQueryRow> {
  const [row] = await tx.execute<GoalQueryRow>(sql`
    select
      (select to_jsonb(g) from "goals"."goals" g where g.id = ${goalId}) as goal,
      (select coalesce(json_agg(to_jsonb(p)), '[]'::json)
         from "goals"."phases" p
         where p.goal_id = ${goalId}) as phases,
      (select coalesce(json_agg(to_jsonb(c) || jsonb_build_object(
                 'source_key', s.key,
                 'source_unit', s.unit,
                 'source_label_key', s.label_key
               ) order by c.position, c.created_at, c.id), '[]'::json)
         from "goals"."commitments" c
         left join "goals"."evidence_sources" s on s.id = c.source_id
         where c.goal_id = ${goalId}) as commitments,
      (select coalesce(json_agg(to_jsonb(f) || jsonb_build_object(
                 'commitment_unit', c.unit
               )), '[]'::json)
         from "goals"."facts" f
         left join "goals"."commitments" c on c.id = f.commitment_id
         where f.goal_id = ${goalId}) as facts,
      (select coalesce(json_agg(jsonb_build_object('month', b.month, 'amount', b.amount)
                                order by b.month), '[]'::json)
         from "goals"."month_budgets" b
         where b.goal_id = ${goalId}) as budgets,
      (select coalesce(json_agg(to_jsonb(o) || jsonb_build_object(
                 'done_on', (select min(f.day) from "goals"."facts" f where f.one_off_id = o.id),
                 'fact_id', (select f.id from "goals"."facts" f where f.one_off_id = o.id limit 1)
               ) order by o.position, o.created_at, o.id), '[]'::json)
         from "goals"."one_offs" o
         where o.goal_id = ${goalId}) as tasks,
      (select coalesce(json_agg(${TREE_COLUMNS}), '[]'::json)
         from "goals"."goals" g) as tree,
      (with recursive down(id, n) as (
           select g.id, 1 from "goals"."goals" g where g.parent_id = ${goalId}
           union all
           select g.id, down.n + 1 from "goals"."goals" g
             join down on g.parent_id = down.id where down.n < 3
         )
       select coalesce(json_agg(jsonb_build_object(
                'goal', to_jsonb(d),
                'commitments', (select coalesce(json_agg(to_jsonb(c) || jsonb_build_object(
                                    'source_key', s.key,
                                    'source_unit', s.unit,
                                    'source_label_key', s.label_key
                                  ) order by c.position, c.created_at, c.id), '[]'::json)
                                  from "goals"."commitments" c
                                  left join "goals"."evidence_sources" s on s.id = c.source_id
                                  where c.goal_id = d.id),
                'facts', (select coalesce(json_agg(to_jsonb(f) || jsonb_build_object(
                                    'commitment_unit', c.unit
                                  )), '[]'::json)
                                  from "goals"."facts" f
                                  left join "goals"."commitments" c on c.id = f.commitment_id
                                  where f.goal_id = d.id),
                'budgets', (select coalesce(json_agg(jsonb_build_object('month', b.month, 'amount', b.amount)
                                                     order by b.month), '[]'::json)
                                  from "goals"."month_budgets" b
                                  where b.goal_id = d.id),
                'tasks', (select coalesce(json_agg(to_jsonb(o) || jsonb_build_object(
                                    'done_on', (select min(f.day) from "goals"."facts" f where f.one_off_id = o.id),
                                    'fact_id', (select f.id from "goals"."facts" f where f.one_off_id = o.id limit 1)
                                  ) order by o.position, o.created_at, o.id), '[]'::json)
                                  from "goals"."one_offs" o
                                  where o.goal_id = d.id)
              ) order by down.n, d.position, d.created_at, d.id), '[]'::json)
         from down
         join "goals"."goals" d on d.id = down.id
        where d.archived_at is null) as branch
  `);

  return row;
}

function toGoalCommitment(row: CommitmentRow, factDayCount: number): GoalCommitment {
  return {
    id: row.id,
    name: row.name,
    cadence: toCadence(row),
    satisfiedBy: toSatisfiedBy(row),
    retiredAt: row.retired_at,
    sourceLabelKey: row.satisfaction === "evidence" && row.source_label_key ? sourceKey(row.source_label_key) : null,
    factDayCount,
  };
}

// Distinct fact days per commitment, from the goal statement's own
// unfiltered `facts` subquery — a one-off's fact carries no `commitment_id`
// and is skipped, the same guard `loadGoal` applies before `toDeclaredFact`.
function factDayCounts(facts: FactRow[]): Map<string, number> {
  const daysByCommitment = new Map<string, Set<string>>();
  for (const fact of facts) {
    if (!fact.commitment_id) continue;
    const days = daysByCommitment.get(fact.commitment_id) ?? new Set<string>();
    days.add(fact.day);
    daysByCommitment.set(fact.commitment_id, days);
  }
  const counts = new Map<string, number>();
  for (const [commitmentId, days] of daysByCommitment) counts.set(commitmentId, days.size);
  return counts;
}

/**
 * The goal's own span, as two `SQL` fragments rather than two values: the
 * reading transaction opens blind, in the same `Promise.all` as the goals
 * one (RNP-03), so nothing in this process has read `created_at` or
 * `horizon` yet when this is built. Each fragment is a scalar subquery on
 * `"goals"."goals"`, fully schema-qualified so it resolves under the reading
 * connection's own `search_path` ("reading, public"), scoped to `goalId` and
 * narrowed to the caller's own row by `goals_select_self` — the very RLS
 * policy `withGoalsDb`'s own queries already lean on, applying here because
 * both transactions carry the same settled claims. `readerFor`'s own
 * contract (`lib/evidence/types.ts`) is what makes this legal without
 * teaching a source's reader anything about `goals`: `from`/`to` are typed
 * `string | SQL`, an opaque bound a reader interpolates and never inspects,
 * and `reading-lookups.ts` never spells the schema name out — only this
 * file, which already reads `goals.*` under its own door, does. Never a
 * second round trip: the subquery runs inside the reading statement itself,
 * the same one statement `queryEvidenceBySource` always sent.
 */
function goalSpan(goalId: string, today: string): { from: SQL; to: SQL } {
  return {
    // The earliest civil day of the goal's non-archived branch (`spanStart`,
    // `lib/goals/tree.ts`): the goal's own, alone. The table is named once, in
    // `t`, so the recursion walks a copy rather than reading it twice.
    from: sql`(with recursive t as (
                 select id, parent_id, created_at, archived_at from "goals"."goals"
               ), b(id, n) as (
                 select id, 0 from t where id = ${goalId}
                 union all
                 select t.id, b.n + 1 from t join b on t.parent_id = b.id where b.n < 3
               )
               select (coalesce(min(t.created_at) filter (where t.archived_at is null), min(t.created_at))
                         at time zone ${TIME_ZONE})::date
                 from t join b on b.id = t.id)`,
    // `horizon` is the first day after the goal (RP-11), already a civil date:
    // the span ends the day before it, or today for a goal with no end.
    to: sql`(select coalesce(g.horizon - 1, ${today}::date) from "goals"."goals" g where g.id = ${goalId})`,
  };
}

// The source keys a goal's own evidence-satisfied commitments name, in its
// own measure unit — the one dedupe `evidenceMeasureTotal` and
// `evidenceDaysForMeasure` both apply, by source key rather than by
// commitment: two commitments naming the same source must not sum its rows
// twice.
export function matchingSourceKeys(goal: GoalRow, commitments: CommitmentRow[]): Set<string> {
  if (!goal.measure_unit) return new Set();
  return new Set(
    commitments
      .filter(
        (row) =>
          row.satisfaction === "evidence" &&
          row.source_key !== null &&
          row.source_unit === goal.measure_unit,
      )
      .map((row) => row.source_key as string),
  );
}

/**
 * The evidence half of `measureTotal` and `weeks` alike (RP-14, RP-17): a quantity in the goal's own
 * measure unit feeds it whether a fact declared it or a source recorded it,
 * and evidence never writes a fact (RP-05), so this is the only place that
 * quantity is ever read. Only a commitment that is both evidence-satisfied
 * and named in the goal's own unit counts — the same "in that measure's
 * unit" rule `measureOf` applies to a declared fact's own unit, read here off
 * the commitment's `source_unit` instead. No date filter here — `goalSpan`
 * already bounded what `bySourceKey` can hold to the goal's own span, in
 * SQL, before these rows ever reached this process. `loadGoal` sums this
 * list for `measureTotal` and hands it whole to `measureByWeek` for `weeks`,
 * so the two never read `bySourceKey` under two different dedupes.
 */
export function evidenceDaysForMeasure(
  goal: GoalRow,
  commitments: CommitmentRow[],
  bySourceKey: Record<string, EvidenceDay[]>,
): EvidenceDay[] {
  const days: EvidenceDay[] = [];
  for (const key of matchingSourceKeys(goal, commitments)) {
    for (const day of bySourceKey[key] ?? []) days.push(day);
  }
  return days;
}

/**
 * Everything derived from one goal's rows and its evidence: the total, the
 * months, the current month's line and the weeks. `loadGoal` and
 * `lib/queries/report.ts` both call it, so a figure the report prints is the
 * one the goal's own screen reads. `evidence: null` is a source that could not
 * be read: the declared half alone (RNP-04).
 */
export function goalFigures(input: {
  goal: GoalRow;
  phases: Phase[];
  commitments: CommitmentRow[];
  facts: FactRow[];
  budgets: MonthBudget[];
  tasks: TaskRow[];
  evidence: Record<string, EvidenceDay[]> | null;
  today: string;
  // The day week 1 opens when it is not the goal's own: a goal holding goals
  // opens with its earliest one.
  openedOn?: string;
}): {
  tasks: PlanTask[];
  plan: PlanInput;
  measureTotal: number;
  months: MonthRow[];
  month: GoalView["month"];
  weeks: ReviewWeek[];
  // The week rule over any span, for a caller that splits a week.
  totalInSpan: (startsOn: string, endsOn: string) => number;
} {
  const { goal, phases, commitments, budgets, evidence, today } = input;
  // A one-off's fact carries no `commitment_id`, and no unit to feed the
  // measure with; only a commitment's own quantity ever can (RP-14).
  const facts = input.facts
    .filter((fact): fact is FactRow & { commitment_id: string } => fact.commitment_id !== null)
    .map(toDeclaredFact);

  // The same civil-day conversion `goalSpan`'s own SQL runs
  // (`(g.created_at at time zone TIME_ZONE)::date`), read here in JS off the
  // one row this statement already carries: week 1 opens the day the goal
  // was created, never a second query.
  const openedOn = input.openedOn ?? civilDateInZone(new Date(goal.created_at));
  const tasks = input.tasks.map((task) => toPlanTask(task, openedOn));
  const rhythm = goal.rhythm ?? null;
  const plan: PlanInput = { rhythm, budgets, tasks, openedOn, horizon: goal.horizon, today };
  // A done task's estimate counts as declared quantity (RP-36): feeds the
  // measure alone, never a commitment's slot.
  const measureFacts = [...facts, ...estimateFacts(tasks, goal.measure_unit)];

  // Null until the first quantity commitment names it (§0.3, 3): nothing to
  // sum into yet, so the total stays zero rather than matching facts with no
  // unit of their own against a measure the goal does not have.
  const declaredTotal = goal.measure_unit ? measureOf(goal.measure_unit, measureFacts) : 0;
  const evidenceDays = evidence ? evidenceDaysForMeasure(goal, commitments, evidence) : [];
  const evidenceTotal = evidenceDays.reduce((total, day) => total + day.quantity, 0);

  const months = monthRows({
    openedOn,
    horizon: goal.horizon,
    today,
    budgets,
    rhythm,
    reached: reachedByMonth({ unit: goal.measure_unit, facts: measureFacts, evidence: evidenceDays }),
  });
  const thisMonth = months.find((entry) => entry.current);
  const month =
    goal.measure_unit === null || !thisMonth
      ? null
      : {
          month: thisMonth.month,
          ...monthLine({
            month: thisMonth.month,
            today,
            budget: budgets.find((budget) => budget.month === monthOf(today)) ?? null,
            reached: thisMonth.reached,
            rhythm,
            openedOn,
            horizon: goal.horizon,
          }),
        };

  const weeks = measureByWeek({
    openedOn,
    horizon: goal.horizon,
    today,
    unit: goal.measure_unit,
    facts: measureFacts,
    evidence: evidenceDays,
    phases,
  });

  return {
    tasks,
    plan,
    measureTotal: declaredTotal + evidenceTotal,
    months,
    month,
    weeks,
    totalInSpan: (startsOn, endsOn) =>
      totalInSpan(goal.measure_unit, measureFacts, evidenceDays, startsOn, endsOn),
  };
}

/**
 * Feeds the goal's own screen in exactly two transactions, fanned with
 * `Promise.all` and never chained (RNP-03) — the same shape `lib/queries/
 * day.ts`'s `loadDay` and `lib/queries/week.ts`'s `loadWeek` already run, over
 * the goal's own span rather than a day or a week. The evidence promise is
 * settled here, not awaited bare: a rejection degrades to `"unreadable"` and
 * `measureTotal` still carries the declared half alone (RNP-04) — a goal
 * screen never fails because another app's rows could not be read.
 *
 * `null` reads as "this goal is not there" — a shape nobody owns or one whose
 * id was never a uuid — and only that; every other rejection (an outage, a
 * dropped connection) propagates untouched, so `goal-screen.tsx`'s own
 * `.catch(() => null)` degrading a Supabase outage to a 404 dies with this
 * function returning the honest thing instead. The non-uuid check runs before
 * either transaction opens — no round trip spent asking the database to
 * refuse a shape it was never going to match (`22P02`).
 */
export async function loadGoal(
  goalId: string,
  today: string = todayInZone(),
): Promise<GoalView | null> {
  if (!z.uuid().safeParse(goalId).success) return null;

  const person = await getPerson();
  if (!person) throw new Error("loadGoal called without a verified session");

  const [row, evidenceOutcome] = await Promise.all([
    withGoalsDb((tx) => queryGoalRow(tx, goalId)),
    withReadingDb((tx) => {
      const { from, to } = goalSpan(goalId, today);
      return queryEvidenceBySource(tx, person.id, from, to);
    }).then(
      (bySourceKey): EvidenceOutcome => ({ status: "read", bySourceKey }),
      (): EvidenceOutcome => ({ status: "unreadable", bySourceKey: {} }),
    ),
  ]);

  if (!row.goal) return null;

  const evidence = evidenceOutcome.status === "read" ? evidenceOutcome.bySourceKey : null;
  const phases = row.phases.map(toPhase);
  const dayCounts = factDayCounts(row.facts);
  const commitments = row.commitments.map((commitment) =>
    toGoalCommitment(commitment, dayCounts.get(commitment.id) ?? 0),
  );

  const tree = buildTree(row.tree.map(toTreeRow));
  const node = tree.byId.get(row.goal.id);
  const openKids = (id: string): TreeNode[] =>
    (tree.byId.get(id)?.children ?? []).map((c) => tree.byId.get(c)!).filter((c) => c.archivedAt === null);
  const holdsGoals = openKids(row.goal.id).length > 0;

  let figures: ReturnType<typeof goalFigures>;
  let rolled: RolledUp | null = null;
  const own = new Map<string, GoalMonths>();
  let up = new Map<string, RolledUp>();
  const spanFrom = holdsGoals ? spanStart(tree, row.goal.id) : civilDateInZone(new Date(row.goal.created_at));

  if (holdsGoals) {
    // A goal holding goals plans through the goals under it: its stored rhythm
    // and month amounts stay unread (RP-80).
    const figuresOf = (entry: BranchEntry, from: string, days: Record<string, EvidenceDay[]> | null) => {
      const holds = openKids(entry.goal.id).length > 0;
      return goalFigures({
        goal: holds ? { ...entry.goal, rhythm: null } : entry.goal,
        phases: entry.goal.id === row.goal!.id ? phases : [],
        commitments: entry.commitments,
        facts: entry.facts,
        budgets: holds ? [] : entry.budgets,
        tasks: entry.tasks,
        evidence: days,
        today,
        openedOn: from,
      });
    };
    const within = (from: string, to: string): Record<string, EvidenceDay[]> | null =>
      evidence === null
        ? null
        : Object.fromEntries(
            Object.entries(evidence).map(([key, days]) => [key, days.filter((d) => d.day >= from && d.day <= to)]),
          );
    const holder: BranchEntry = {
      goal: row.goal,
      commitments: row.commitments,
      facts: row.facts,
      budgets: row.budgets,
      tasks: row.tasks,
    };
    figures = figuresOf(holder, spanFrom, evidence);
    own.set(row.goal.id, { unit: row.goal.measure_unit, months: monthFigures(figures.months, []) });
    for (const entry of row.branch) {
      const from = spanStart(tree, entry.goal.id);
      const f = figuresOf(entry, from, within(from, entry.goal.horizon === null ? today : dayBefore(entry.goal.horizon)));
      own.set(entry.goal.id, { unit: entry.goal.measure_unit, months: monthFigures(f.months, []) });
    }
    up = rollUp(tree, own);
    rolled = up.get(row.goal.id) ?? null;
  } else {
    figures = goalFigures({
      goal: row.goal,
      phases,
      commitments: row.commitments,
      facts: row.facts,
      budgets: row.budgets,
      tasks: row.tasks,
      evidence,
      today,
    });
  }

  const thisMonth = monthOf(today);
  let months = figures.months;
  let month = figures.month;
  let measureTotal = figures.measureTotal;
  let measureUnit = row.goal.measure_unit;
  if (rolled) {
    measureUnit = rolled.unit;
    months = monthsOfSpan(spanFrom, row.goal.horizon, today).map((m) => ({
      month: m,
      planned: rolled.months.get(m)?.planned ?? null,
      reached: rolled.months.get(m)?.reached ?? 0,
      current: m === thisMonth,
      past: m < thisMonth,
    }));
    measureTotal = months.reduce((total, entry) => total + entry.reached, 0);
    const current = months.find((entry) => entry.current);
    month =
      measureUnit === null || !current
        ? null
        : {
            month: current.month,
            ...monthLine({
              month: current.month,
              today,
              budget: current.planned === null ? null : { month: current.month, amount: current.planned },
              reached: current.reached,
              openedOn: spanFrom,
              horizon: row.goal.horizon,
            }),
          };
  }

  const ref = (n: TreeNode): GoalRef => ({ id: n.id, name: n.name, horizon: n.horizon });
  const parent = node?.parentId ? tree.byId.get(node.parentId) : undefined;
  const below = node ? branchOf(tree, node.id).slice(1).map((id) => tree.byId.get(id)!) : [];
  let latest: TreeNode | null = null;
  for (const n of below) {
    // A goal with no end ends last.
    const later = latest === null || (n.horizon === null ? latest.horizon !== null : latest.horizon !== null && n.horizon > latest.horizon);
    if (later) latest = n;
  }
  const unitOf = (n: TreeNode): string | null => up.get(n.id)?.unit ?? n.measureUnit;

  const children = (node?.children ?? []).map((id) => {
    const n = tree.byId.get(id)!;
    const f = n.archivedAt === null ? (up.get(id)?.months ?? own.get(id)?.months)?.get(thisMonth) : undefined;
    const unit = unitOf(n);
    let firstPlanned: { month: string; planned: number } | null = null;
    if (n.archivedAt === null) {
      for (const [m, fig] of up.get(id)?.months ?? own.get(id)?.months ?? []) {
        if (m < thisMonth || fig.planned === null || fig.planned <= 0) continue;
        if (firstPlanned === null || m < firstPlanned.month) firstPlanned = { month: m, planned: fig.planned };
      }
    }
    return {
      id: n.id,
      name: n.name,
      level: n.level as Level,
      unit,
      inUnit: unit !== null && unit === measureUnit,
      month: unit === null || !f ? null : { planned: f.planned, reached: f.reached },
      firstPlanned,
      endedOn: n.horizon !== null && n.horizon <= today ? dayBefore(n.horizon) : null,
      archivedAt: n.archivedAt,
    };
  });

  return {
    id: row.goal.id,
    name: row.goal.name,
    horizon: row.goal.horizon,
    endedOn: row.goal.horizon !== null && row.goal.horizon <= today ? dayBefore(row.goal.horizon) : null,
    createdAt: row.goal.created_at,
    measureName: row.goal.measure_name,
    measureUnit,
    archivedAt: row.goal.archived_at,
    measureTotal,
    phases,
    commitments,
    weeks: figures.weeks,
    evidence: evidenceOutcome.status,
    month,
    months,
    budgets: holdsGoals ? [] : row.budgets,
    tasks: figures.tasks,
    rhythm: holdsGoals ? null : (row.goal.rhythm ?? null),
    planSeen: row.goal.plan_seen ?? null,
    plan: figures.plan,
    roadmap: holdsGoals
      ? { state: "noRhythm", months: [], unplaced: [], end: null, lastDay: row.goal.horizon === null ? null : dayBefore(row.goal.horizon) }
      : fillPlan(figures.plan),
    note: row.goal.note ?? null,
    parent: parent ? ref(parent) : null,
    ancestors: (node?.ancestors ?? []).map((id) => ref(tree.byId.get(id)!)).reverse(),
    level: node?.level ?? null,
    holdsGoals,
    children,
    outOfUnit: rolled?.outOfUnit ?? [],
    branchOpenCount: below.filter((n) => n.archivedAt === null).length,
    latestBelow: latest ? ref(latest) : null,
    above: parent ? ref(parent) : null,
    tree: tree.order,
  };
}

// A month list as `rollUp` reads it: the amounts a goal's own rows plan.
function monthFigures(rows: MonthRow[], budgets: MonthBudget[]): Map<string, MonthFigure> {
  return new Map(
    rows.map((r) => [
      r.month,
      { planned: r.planned, reached: r.reached, ownBudget: budgets.some((b) => b.month === r.month) },
    ]),
  );
}

export type GoalPlace = {
  goal: GoalRef;
  level: Level | null;
  openedOn: string;
  archivedAt: string | null;
  tree: TreeNode[];
};

/**
 * Where a goal sits, for the screen that opens a goal inside it: the goal and
 * the person's whole tree, in one transaction and one statement.
 */
export async function loadGoalPlace(goalId: string): Promise<GoalPlace | null> {
  if (!z.uuid().safeParse(goalId).success) return null;

  const [row] = await withGoalsDb((tx) =>
    tx.execute<{ goal: (GoalRef & { created_at: string; archived_at: string | null }) | null; tree: TreeSqlRow[] }>(sql`
      select
        (select jsonb_build_object('id', g.id, 'name', g.name, 'horizon', g.horizon,
                                   'created_at', g.created_at, 'archived_at', g.archived_at)
           from "goals"."goals" g where g.id = ${goalId}) as goal,
        (select coalesce(json_agg(${TREE_COLUMNS}), '[]'::json) from "goals"."goals" g) as tree
    `),
  );
  if (!row.goal) return null;

  const tree = buildTree(row.tree.map(toTreeRow));
  return {
    goal: { id: row.goal.id, name: row.goal.name, horizon: row.goal.horizon },
    level: tree.byId.get(row.goal.id)?.level ?? null,
    openedOn: civilDateInZone(new Date(row.goal.created_at)),
    archivedAt: row.goal.archived_at,
    tree: tree.order,
  };
}

// A habit with no goal (RP-100), as the «Hábitos sin meta» section draws it.
export type LooseCommitment = GoalCommitment & { note: string | null };

/**
 * The person's habits with no goal, live and retired, in their own order: one
 * transaction, one statement. RLS alone scopes it.
 */
export async function listLooseCommitments(): Promise<LooseCommitment[]> {
  const rows = await withGoalsDb((tx) =>
    tx.execute<{ row: CommitmentRow & { fact_day_count: number } }>(sql`
      select to_jsonb(c) || jsonb_build_object(
               'source_key', s.key,
               'source_unit', s.unit,
               'source_label_key', s.label_key,
               'fact_day_count', (select count(distinct f.day)::int from "goals"."facts" f where f.commitment_id = c.id)
             ) as row
        from "goals"."commitments" c
        left join "goals"."evidence_sources" s on s.id = c.source_id
        where c.goal_id is null
        order by c.position, c.created_at, c.id
    `),
  );
  return rows.map(({ row }) => ({ ...toGoalCommitment(row, row.fact_day_count), note: row.note ?? null }));
}

function toGoalSummary(row: GoalRow): GoalSummary {
  return {
    id: row.id,
    name: row.name,
    horizon: row.horizon,
    measureName: row.measure_name,
    measureUnit: row.measure_unit,
    archivedAt: row.archived_at,
  };
}

/**
 * One transaction, one statement: every *open* goal the person has, for
 * `app/(app)/metas/[goalId]/compromisos/nuevo/page.tsx`'s own lookup — an
 * archived goal excluded (RP-24) is what makes a direct visit to that route
 * 404 for one, the same way "no add-commitment button" reads on its own
 * screen. `listGoalsForMetas` below is `/metas`'s own query: it needs the
 * archived half too, to list under "Archivadas".
 *
 * `cache()`-wrapped: the layout's rail and the screen's `otherGoals` read it in
 * one render, so a page pays this statement once (RNP-18). It takes no
 * argument, so the one entry is the whole request's.
 *
 * The rows come in the tree's preorder (siblings by position, a goal's goals
 * right after it), each with its parent among the open ones: the rail draws
 * the tree from this list.
 */
export type OpenGoal = GoalSummary & { parentId: string | null };

export const listGoals = cache(async function listGoals(): Promise<OpenGoal[]> {
  const rows = await withGoalsDb((tx) =>
    tx.execute<GoalRow & { parent_id: string | null; position: number }>(sql`
      select id, name, horizon, measure_name, measure_unit, archived_at, created_at, parent_id, position
      from "goals"."goals"
      where archived_at is null
      order by position, created_at, id
    `),
  );

  // The civil day is the person's, so the cut is JS against `todayInZone()`,
  // never `current_date`: an ended goal is refused like an archived one.
  const today = todayInZone();
  const open = rows.filter((row) => row.horizon === null || row.horizon > today);
  const tree = buildTree(
    open.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      position: row.position,
      createdAt: row.created_at,
      name: row.name,
      horizon: row.horizon,
      archivedAt: row.archived_at,
      measureUnit: row.measure_unit,
    })),
  );
  const byId = new Map(open.map((row) => [row.id, row]));
  return tree.order.map((node) => ({
    ...toGoalSummary(byId.get(node.id)!),
    parentId: node.ancestors.length > 0 ? node.ancestors[0] : null,
  }));
});

// An open goal's current month, as `/metas` draws it beside the goal: the
// amount in its unit, or the tasks when it measures nothing. The amount folds
// in the evidence readings, as Hoy's month line does; they ride a second
// connection, in parallel with the goals statement.
export type MetasMonth =
  | { kind: "amount"; month: string; planned: number | null; reached: number }
  | { kind: "tasks"; month: string; done: number; total: number };

// Where a goal sits in the tree, on every row `/metas` lists.
export type MetasSummary = GoalSummary & { parentId: string | null; level: Level | null };

// `outOfUnit` is the goals under it in another unit, which add nothing to its month.
export type MetasOpenGoal = MetasSummary & {
  month: MetasMonth | null;
  // The unit `month` is drawn in: the goals' own when it holds goals, else its measure's.
  monthUnit: string | null;
  outOfUnit: { id: string; name: string; unit: string }[];
};

type MetasRow = GoalRow & {
  created_at: string;
  position: number;
  facts: FactRow[];
  budgets: { month: string; amount: number }[];
  tasks: TaskRow[];
  measure_sources: { satisfaction: string; source_key: string | null; source_unit: string | null }[];
};

/**
 * `/metas`'s own query (RP-24): one statement, every goal the person has
 * ever opened, split into "open", "ended" and "archived" here rather than by a
 * second round trip — the screen lists the first, then a quiet "Archivadas"
 * section for the second, each still its own way into `Meta.dc.html`. The
 * month's facts, budget and tasks ride the same statement, per goal.
 */
export async function listGoalsForMetas(today: string = todayInZone()): Promise<{
  open: MetasOpenGoal[];
  ended: MetasSummary[];
  archived: MetasSummary[];
}> {
  const month = monthOf(today);
  const person = await getPerson();
  if (!person) throw new Error("listGoalsForMetas called without a verified session");
  const [rows, evidenceOutcome] = await Promise.all([
    withGoalsDb((tx) =>
      tx.execute<MetasRow>(sql`
        select g.id, g.name, g.horizon, g.measure_name, g.measure_unit, g.archived_at,
          g.rhythm, g.created_at, g.parent_id, g.note, g.position,
          (select coalesce(json_agg(to_jsonb(f) || jsonb_build_object(
                     'commitment_unit', c.unit
                   )), '[]'::json)
             from "goals"."facts" f
             left join "goals"."commitments" c on c.id = f.commitment_id
             where f.goal_id = g.id
               and f.day between ${month}::date and ${today}::date) as facts,
          (select coalesce(json_agg(jsonb_build_object('month', b.month, 'amount', b.amount)), '[]'::json)
             from "goals"."month_budgets" b
             where b.goal_id = g.id) as budgets,
          (select coalesce(json_agg(to_jsonb(o) || jsonb_build_object(
                     'done_on', (select min(f.day) from "goals"."facts" f where f.one_off_id = o.id)
                   ) order by o.position, o.created_at, o.id), '[]'::json)
             from "goals"."one_offs" o where o.goal_id = g.id) as tasks,
          (select coalesce(json_agg(jsonb_build_object(
                     'satisfaction', c.satisfaction,
                     'source_key', s.key,
                     'source_unit', s.unit
                   )), '[]'::json)
             from "goals"."commitments" c
             join "goals"."evidence_sources" s on s.id = c.source_id
             where c.goal_id = g.id and c.satisfaction = 'evidence') as measure_sources
        from "goals"."goals" g
        order by g.position, g.created_at, g.id
      `),
    ),
    readEvidenceOutcome(person.id, month, today),
  ]);

  const tree = buildTree(
    rows.map((row) =>
      toTreeRow({
        id: row.id,
        name: row.name,
        parent_id: row.parent_id ?? null,
        position: row.position,
        created_at: row.created_at,
        horizon: row.horizon,
        archived_at: row.archived_at,
        measure_unit: row.measure_unit,
      }),
    ),
  );
  const holds = (id: string): boolean =>
    (tree.byId.get(id)?.children ?? []).some((c) => tree.byId.get(c)!.archivedAt === null);

  // A goal holding goals plans through the ones under it: its stored rhythm
  // and month amounts stay unread (RP-80).
  const planOfRow = (row: MetasRow, tasks: PlanTask[], openedOn: string): PlanInput => ({
    rhythm: holds(row.id) ? null : (row.rhythm ?? null),
    budgets: holds(row.id) ? [] : row.budgets,
    tasks,
    openedOn,
    horizon: row.horizon,
    today,
  });

  const figureOf = (row: MetasRow, unit: string): { planned: number | null; reached: number } => {
    const openedOn = civilDateInZone(new Date(row.created_at));
    const tasks = row.tasks.map((task) => toPlanTask(task, openedOn));
    const plan = planOfRow(row, tasks, openedOn);
    const declared = row.facts
      .filter((fact): fact is FactRow & { commitment_id: string } => fact.commitment_id !== null)
      .map(toDeclaredFact);
    const doneTasks = estimateFacts(tasks, unit).filter((fact) => monthOf(fact.day) === month);
    const reached = reachedByMonth({
      unit,
      facts: [...declared, ...doneTasks],
      evidence: evidenceDaysFor(unit, row.measure_sources, evidenceOutcome.bySourceKey),
    }).get(month) ?? 0;
    const planned = screenPlanned(plannedOf(month, plan), plan.budgets.some((budget) => budget.month === month));
    return { planned, reached };
  };

  const own = new Map<string, GoalMonths>();
  for (const row of rows) {
    if (row.archived_at !== null || row.measure_unit === null) continue;
    const { planned, reached } = figureOf(row, row.measure_unit);
    own.set(row.id, {
      unit: row.measure_unit,
      months: new Map([[month, { planned, reached, ownBudget: false }]]),
    });
  }
  const rolled = rollUp(tree, own);

  const amountOf = (planned: number | null, reached: number): MetasMonth | null =>
    planned === null && reached === 0 ? null : { kind: "amount", month, planned, reached };

  const toMonth = (row: MetasRow): MetasMonth | null => {
    const sums = holds(row.id) ? rolled.get(row.id) : undefined;
    if (sums && sums.unit !== null) {
      const f = sums.months.get(month);
      return amountOf(f?.planned ?? null, f?.reached ?? 0);
    }
    const unit = row.measure_unit;
    if (unit === null) {
      const openedOn = civilDateInZone(new Date(row.created_at));
      const tasks = row.tasks.map((task) => toPlanTask(task, openedOn));
      const items = planMonthList(planOfRow(row, tasks, openedOn), month);
      if (items.length === 0) return null;
      return { kind: "tasks", month, done: items.filter((item) => item.done).length, total: items.length };
    }
    const { planned, reached } = figureOf(row, unit);
    return amountOf(planned, reached);
  };

  const placed = (row: MetasRow): MetasSummary => ({
    ...toGoalSummary(row),
    parentId: row.parent_id ?? null,
    level: tree.byId.get(row.id)?.level ?? null,
  });

  // Archived wins over ended: the check runs first.
  const archived = rows.filter((row) => row.archived_at !== null).map(placed);
  const live = new Map(rows.filter((row) => row.archived_at === null).map((row) => [row.id, row]));
  return {
    open: tree.order
      .map((n) => live.get(n.id))
      .filter((row): row is MetasRow => row !== undefined && (row.horizon === null || row.horizon > today))
      .map((row) => ({
        ...placed(row),
        month: toMonth(row),
        monthUnit: (holds(row.id) ? rolled.get(row.id)?.unit : null) ?? row.measure_unit,
        outOfUnit: holds(row.id) ? (rolled.get(row.id)?.outOfUnit ?? []) : [],
      })),
    ended: [...live.values()].filter((row) => row.horizon !== null && row.horizon <= today).map(placed),
    archived,
  };
}
