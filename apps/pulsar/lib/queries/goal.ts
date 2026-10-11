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
  plannedOf,
  reachedByMonth,
  type MonthBudget,
  type MonthRow,
} from "@/lib/plan/months";
import { sourceKey, type SourceKey } from "@/i18n/translator";

// `withReadingDb`'s query fans out over `knownSourceKeys()`
// (`lib/evidence/registry.ts`), for the same reason `lib/queries/day.ts` and
// `lib/queries/week.ts` do: which source a goal's commitments actually name
// is only known once the goals query resolves, and waiting on that would
// turn this file's own `Promise.all` into the chain RNP-03 forbids.

export type GoalRow = {
  id: string;
  name: string;
  horizon: string;
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
};

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
};

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
  horizon: string;
  // The last day the goal counted: `dayBefore(horizon)` once `horizon` is
  // today or past, null while it still runs. Archived or not — the screen
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
  horizon: string;
  measureName: string | null;
  measureUnit: string | null;
  archivedAt: string | null;
};

/**
 * One statement, six subqueries: the goal row scoped by id, and every phase,
 * commitment, fact, month budget, one-off that name it — unfiltered by `retired_at` or by day, so
 * a goal's screen reads its whole history in the one round trip. RLS alone
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
         where o.goal_id = ${goalId}) as tasks
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
function goalSpan(goalId: string): { from: SQL; to: SQL } {
  return {
    // A civil day, the same conversion `civilDateInZone` applies in JS
    // elsewhere in this file, done here in SQL instead so the bound never
    // leaves the statement that needs it.
    from: sql`(select (g.created_at at time zone ${TIME_ZONE})::date
                 from "goals"."goals" g where g.id = ${goalId})`,
    // `horizon` is the first day after the goal (RP-11), already a civil date:
    // the span ends the day before it.
    to: sql`(select g.horizon - 1 from "goals"."goals" g where g.id = ${goalId})`,
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
  const openedOn = civilDateInZone(new Date(goal.created_at));
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
      const { from, to } = goalSpan(goalId);
      return queryEvidenceBySource(tx, person.id, from, to);
    }).then(
      (bySourceKey): EvidenceOutcome => ({ status: "read", bySourceKey }),
      (): EvidenceOutcome => ({ status: "unreadable", bySourceKey: {} }),
    ),
  ]);

  if (!row.goal) return null;

  const phases = row.phases.map(toPhase);
  const dayCounts = factDayCounts(row.facts);
  const commitments = row.commitments.map((commitment) =>
    toGoalCommitment(commitment, dayCounts.get(commitment.id) ?? 0),
  );
  const { tasks, plan, measureTotal, months, month: currentMonth, weeks } = goalFigures({
    goal: row.goal,
    phases,
    commitments: row.commitments,
    facts: row.facts,
    budgets: row.budgets,
    tasks: row.tasks,
    evidence: evidenceOutcome.status === "read" ? evidenceOutcome.bySourceKey : null,
    today,
  });

  return {
    id: row.goal.id,
    name: row.goal.name,
    horizon: row.goal.horizon,
    endedOn: row.goal.horizon <= today ? dayBefore(row.goal.horizon) : null,
    createdAt: row.goal.created_at,
    measureName: row.goal.measure_name,
    measureUnit: row.goal.measure_unit,
    archivedAt: row.goal.archived_at,
    measureTotal,
    phases,
    commitments,
    weeks,
    evidence: evidenceOutcome.status,
    month: currentMonth,
    months,
    budgets: row.budgets,
    tasks,
    rhythm: row.goal.rhythm ?? null,
    planSeen: row.goal.plan_seen ?? null,
    plan,
    roadmap: fillPlan(plan),
  };
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
 */
export const listGoals = cache(async function listGoals(): Promise<GoalSummary[]> {
  const rows = await withGoalsDb((tx) =>
    tx.execute<GoalRow>(sql`
      select id, name, horizon, measure_name, measure_unit, archived_at
      from "goals"."goals"
      where archived_at is null
      order by position, created_at, id
    `),
  );

  // The civil day is the person's, so the cut is JS against `todayInZone()`,
  // never `current_date`: an ended goal is refused like an archived one.
  const today = todayInZone();
  return rows.filter((row) => row.horizon > today).map(toGoalSummary);
});

// An open goal's current month, as `/metas` draws it beside the goal: the
// amount in its unit, or the tasks when it measures nothing. The amount folds
// in the evidence readings, as Hoy's month line does; they ride a second
// connection, in parallel with the goals statement.
export type MetasMonth =
  | { kind: "amount"; month: string; planned: number | null; reached: number }
  | { kind: "tasks"; month: string; done: number; total: number };

export type MetasOpenGoal = GoalSummary & { month: MetasMonth | null };

type MetasRow = GoalRow & {
  created_at: string;
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
  ended: GoalSummary[];
  archived: GoalSummary[];
}> {
  const month = monthOf(today);
  const person = await getPerson();
  if (!person) throw new Error("listGoalsForMetas called without a verified session");
  const [rows, evidenceOutcome] = await Promise.all([
    withGoalsDb((tx) =>
      tx.execute<MetasRow>(sql`
        select g.id, g.name, g.horizon, g.measure_name, g.measure_unit, g.archived_at,
          g.rhythm, g.created_at,
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

  const toMonth = (row: MetasRow): MetasMonth | null => {
    const unit = row.measure_unit;
    const openedOn = civilDateInZone(new Date(row.created_at));
    const tasks = row.tasks.map((task) => toPlanTask(task, openedOn));
    const rhythm = row.rhythm ?? null;
    const plan: PlanInput = {
      rhythm,
      budgets: row.budgets,
      tasks,
      openedOn,
      horizon: row.horizon,
      today,
    };
    if (unit === null) {
      const items = planMonthList(plan, month);
      if (items.length === 0) return null;
      return { kind: "tasks", month, done: items.filter((item) => item.done).length, total: items.length };
    }
    const declared = row.facts
      .filter((fact): fact is FactRow & { commitment_id: string } => fact.commitment_id !== null)
      .map(toDeclaredFact);
    const doneTasks = estimateFacts(tasks, unit).filter((fact) => monthOf(fact.day) === month);
    const reached = reachedByMonth({
      unit,
      facts: [...declared, ...doneTasks],
      evidence: evidenceDaysFor(unit, row.measure_sources, evidenceOutcome.bySourceKey),
    }).get(month) ?? 0;
    const planned = plannedOf(month, plan);
    if (planned === null && reached === 0) return null;
    return { kind: "amount", month, planned, reached };
  };

  // Archived wins over ended: the check runs first.
  const archived = rows.filter((row) => row.archived_at !== null).map(toGoalSummary);
  const live = rows.filter((row) => row.archived_at === null);
  return {
    open: live
      .filter((row) => row.horizon > today)
      .map((row) => ({ ...toGoalSummary(row), month: toMonth(row) })),
    ended: live.filter((row) => row.horizon <= today).map(toGoalSummary),
    archived,
  };
}
