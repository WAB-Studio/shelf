import "server-only";

import { sql } from "drizzle-orm";

import { deriveDay } from "@/lib/day/derive";
import { periodDoneOn } from "@/lib/day/period";
import { evidenceDaysFor } from "@/lib/day/measure-inputs";
import { measureByWeek } from "@/lib/day/review";
import { latestFactByCommitment, type LoggedFact } from "@/lib/day/logged-fact";
import type {
  Cadence,
  CommitmentPlan,
  DaySlot,
  DayView,
  DeclaredFact,
  Phase,
  SatisfiedBy,
} from "@/lib/day/types";
import type { PlanInput, PlanItem, PlanTask } from "@/lib/plan/roadmap";
import { planMonthList, planMoved, type PlanNotice } from "@/lib/plan/roadmap-read";
import { monthLine, monthOf, reachedByMonth, type MonthLine } from "@/lib/plan/months";
import { phasePositions } from "@/lib/day/row-phrases";
import { dayBefore } from "@/lib/day/weeks";
import { queryEvidenceBySource } from "@/lib/queries/evidence";
import type { EvidenceOutcome } from "@/lib/queries/evidence";
import {
  toCadence,
  toDeclaredFact,
  toEvidenceByCommitment,
  toPhase,
  toSatisfiedBy,
  type CommitmentRow as BaseCommitmentRow,
  type PhaseRow as BasePhaseRow,
} from "@/lib/queries/rows";
import { sourceKey, type SourceKey } from "@/i18n/translator";
import { getPerson, withGoalsDb, withReadingDb, type Transaction } from "@/lib/session";
import { civilDateInZone, TIME_ZONE, todayInZone, weekOf } from "@/lib/zone";
import { branchOf, buildTree, rollUp, rootOf, type GoalMonths, type Level, type Tree } from "@/lib/goals/tree";

// `withReadingDb`'s query fans out over `knownSourceKeys()`
// (`lib/evidence/registry.ts`), never over the day's own commitments: a
// distinct set of keys can only be known once the goals query has already
// returned, and waiting on that would turn the second transaction's opening
// into a continuation of the first's — the very chain RNP-03 forbids. Both
// transactions open, settle and query concurrently instead; the mapping step
// below decides, once both have answered, which commitment each source's
// rows belong to.
//
// This is also why `withReadingDb` runs one query *per known key*, not one
// per commitment that actually needs it: today, with one key, that is four
// statements total. **Four is
// a fact of today's registry, not a law of this file.** The day a second key
// lands, a person with no commitment pointing at it still pays its query —
// RNP-03's "bounded" still holds (bounded by the catalogue's own size, which
// RNP-10 keeps small), but "four" stops being the count.

type GoalRow = {
  id: string;
  name: string;
  // Null: a goal with no end (RP-99), open for good.
  horizon: string | null;
  created_at: string;
  measure_name: string | null;
  measure_unit: string | null;
  rhythm: number | null;
  plan_seen: string | null;
  parent_id: string | null;
  position: number;
};

// `source_key` and `source_unit` ride in from the join to `evidence_sources`;
// neither column exists on `commitments` itself (RNP-10 keeps the source a
// row of configuration, not a commitment column). `goal_id` widens
// `rows.ts`'s own `CommitmentRow` — nothing `CommitmentPlan`
// reads, so `toCommitmentPlan` still ignores it; `DayScreen` is what
// groups a slot by goal and names its row.
type CommitmentRow = BaseCommitmentRow & { goal_id: string | null; source_label_key: string | null };

type PhaseRow = BasePhaseRow & { goal_id: string };

// `commitment_unit` rides in from the join to `commitments`: a fact carries a
// bare quantity, never its own unit (`db/schema/commitments.ts`'s own
// comment — "the unit belongs here, never to the fact that repeats it").
// `id` rides in from `to_jsonb(f)` like every other bare column here — it was
// read out from the start, only never named on this type before a row's own fact
// had to be undone (RP-05).
type FactRow = {
  id: string;
  commitment_id: string | null;
  one_off_id: string | null;
  goal_id: string | null;
  day: string;
  written_at: string;
  quantity: number | null;
  note: string | null;
  commitment_unit: string | null;
};

type MonthBudgetRow = { goal_id: string; month: string; amount: number };

type OneOffRow = {
  id: string;
  goal_id: string | null;
  name: string;
  day: string | null;
  note: string | null;
};

// The one statement's whole shape. `goals` and `one_offs` are fetched here
// and, beside `view`, returned from `loadDay` below as `GoalSummary[]` and
// `OneOffSummary[]` — `deriveDay` takes no goals array and `DayView` has no
// place for a one-off, so `DayScreen` is what groups a slot under the
// goal it belongs to and draws a one-off beneath the last one.
type DoneOneOffRow = {
  id: string;
  goal_id: string | null;
  name: string;
  fact_id: string;
  written_at: string;
  note: string | null;
};

// Every task of an open goal with its own done day: what the plan (`fillPlan`)
// places the month's tasks from.
type GoalTaskRow = {
  id: string;
  goal_id: string;
  parent_id: string | null;
  name: string;
  planned_month: string | null;
  day: string | null;
  estimate: number | null;
  note: string | null;
  in_plan: boolean;
  position: number;
  created_at: string;
  done_on: string | null;
};

export type MonthTask = {
  id: string;
  name: string;
  estimate: number | null;
  note: string | null;
  parentName: string | null;
  // The hours the plan places in this month for the task: the part of a split one.
  part: number;
};

// Every evidence commitment of a goal, retired ones included: the source keys
// a goal's measure reads, as `loadGoal` reads them.
type MeasureSourceRow = {
  goal_id: string;
  satisfaction: string;
  source_key: string | null;
  source_unit: string | null;
};

type GoalsQueryRow = {
  goals: GoalRow[];
  commitments: CommitmentRow[];
  phases: PhaseRow[];
  facts: FactRow[];
  month_budgets: MonthBudgetRow[];
  one_offs: OneOffRow[];
  done_one_offs: DoneOneOffRow[];
  goal_tasks: GoalTaskRow[];
  dayless_count: number;
  measure_sources: MeasureSourceRow[];
  scheduled_count: number;
  last_ended: { name: string; horizon: string } | null;
  ended_this_week: { id: string; name: string; horizon: string }[];
  first_goal_at: string | null;
};

// A goal is open on `day` while it has no end or its horizon, the first day after it,
// lies after `day`. The one rule every subquery below that asks "open" reuses.
function openGoal(alias: string, day: string) {
  return sql`${sql.raw(alias)}.archived_at is null and (${sql.raw(alias)}.horizon is null or ${sql.raw(alias)}.horizon > ${day}::date)`;
}

export type EndedGoal = { id: string; name: string; lastDay: string };

/**
 * One statement, one subquery per thing the day reads: everything the day's derivation needs,
 * scoped to the caller's own rows by RLS alone — no `user_id` filter is
 * written here, the same choice `lib/evidence/reading-lookups.ts` took, so
 * the policy is the reason the rows are safe, not a second copy of it.
 *
 * `retired_at` is `timestamptz`: read as `::date` bare it renders in the
 * session's own zone (UTC here), so a commitment retired after 19:00 Bogotá
 * would still ask for one more day. `at time zone ${TIME_ZONE}` first turns
 * it into the person's own civil day before the cast, the same move
 * `lib/queries/goal.ts`'s `goalSpan` already makes on `created_at`.
 *
 * `facts` reads from the earlier of the week's Monday and the month's first:
 * `times_per_month` asks by its month and counts what the week alone never
 * reads. What is week-bound (the goal's measure) narrows back in TS.
 *
 * `goals` is the list RP-24 filters: an archived goal is never in it, and
 * `DayScreen` only ever groups a row under a goal it finds here. `commitments`
 * and `one_offs` do not join to the goal, so a row of an archived goal still
 * rides along, but nothing loops over either outside the per-goal grouping and
 * it never draws. `goal_tasks` and `scheduled_count` join
 * only open goals (`openGoal`); `month_budgets` also keeps a goal that ended this
 * week, for the sum of the general above it. `goals.length === 0` is also what decides the
 * day's own empty state (`empty-day.tsx`), so an all-archived person needs no
 * second check.
 */
async function queryGoalsRow(
  tx: Transaction,
  day: string,
  weekStart: string,
  isToday: boolean,
): Promise<GoalsQueryRow> {
  const [row] = await tx.execute<GoalsQueryRow>(sql`
    select
      (select coalesce(json_agg(to_jsonb(g) order by g.position, g.created_at, g.id), '[]'::json)
         from "goals"."goals" g
         where ${openGoal("g", weekStart)}) as goals,
      (select min(t.created_at) from (
         select g.created_at from "goals"."goals" g
         union all
         select c.created_at from "goals"."commitments" c where c.goal_id is null
       ) t) as first_goal_at,
      (select coalesce(json_agg(to_jsonb(c) || jsonb_build_object(
                 'source_key', s.key,
                 'source_unit', s.unit,
                 'source_label_key', s.label_key
               ) order by c.position, c.created_at, c.id), '[]'::json)
         from "goals"."commitments" c
         left join "goals"."evidence_sources" s on s.id = c.source_id
         where c.retired_at is null or (c.retired_at at time zone ${TIME_ZONE})::date >= ${day}::date) as commitments,
      (select coalesce(json_agg(jsonb_build_object(
                 'goal_id', c.goal_id,
                 'satisfaction', c.satisfaction,
                 'source_key', s.key,
                 'source_unit', s.unit
               )), '[]'::json)
         from "goals"."commitments" c
         join "goals"."evidence_sources" s on s.id = c.source_id
         where c.satisfaction = 'evidence') as measure_sources,
      (select coalesce(json_agg(to_jsonb(p) order by p.starts_on, p.created_at, p.id), '[]'::json)
         from "goals"."phases" p) as phases,
      (select coalesce(json_agg(to_jsonb(f) || jsonb_build_object(
                 'commitment_unit', c.unit
               ) order by f.day, f.written_at, f.id), '[]'::json)
         from "goals"."facts" f
         left join "goals"."commitments" c on c.id = f.commitment_id
         where f.day between least(${weekStart}::date, date_trunc('month', ${day}::date)::date) and ${day}::date) as facts,
      (select coalesce(json_agg(to_jsonb(b) order by b.month), '[]'::json)
         from "goals"."month_budgets" b
         join "goals"."goals" g on g.id = b.goal_id
           and ${openGoal("g", weekStart)}
         where b.month >= (date_trunc('month', ${day}::date) - interval '1 month')::date) as month_budgets,
      (select coalesce(json_agg(to_jsonb(o) order by o.position, o.created_at, o.id), '[]'::json)
         from "goals"."one_offs" o
         where o.day <= ${day}::date
           and not exists (
             select 1 from "goals"."facts" f where f.one_off_id = o.id
           )) as one_offs,
      (select coalesce(json_agg(jsonb_build_object(
                 'id', o.id,
                 'goal_id', o.goal_id,
                 'name', o.name,
                 'fact_id', f.id,
                 'written_at', f.written_at,
                 'note', o.note
               ) order by f.written_at), '[]'::json)
         from "goals"."one_offs" o
         join "goals"."facts" f on f.one_off_id = o.id
         where f.day = ${day}::date) as done_one_offs,
      (select coalesce(json_agg(jsonb_build_object(
                 'id', o.id,
                 'goal_id', o.goal_id,
                 'parent_id', o.parent_id,
                 'name', o.name,
                 'planned_month', o.planned_month,
                 'day', o.day,
                 'estimate', o.estimate,
                 'note', o.note,
                 'in_plan', o.in_plan,
                 'position', o.position,
                 'created_at', o.created_at,
                 'done_on', (select min(f.day) from "goals"."facts" f where f.one_off_id = o.id)
               ) order by o.position, o.created_at, o.id), '[]'::json)
         from "goals"."one_offs" o
         join "goals"."goals" g on g.id = o.goal_id and ${openGoal("g", day)}
         where ${isToday}::boolean) as goal_tasks,
      (select count(*)::int
         from "goals"."one_offs" o
         where o.day is null
           and o.planned_month is null and o.parent_id is null
           and not exists (
             select 1 from "goals"."facts" f where f.one_off_id = o.id
           )
           and o.goal_id is null) as dayless_count,
      (select count(*)::int
         from "goals"."one_offs" o
         where o.day > ${day}::date
           and not exists (
             select 1 from "goals"."facts" f where f.one_off_id = o.id
           )
           and (o.goal_id is null or exists (
             select 1 from "goals"."goals" g
             where g.id = o.goal_id and ${openGoal("g", day)}
           ))) as scheduled_count,
      (select jsonb_build_object('name', g.name, 'horizon', g.horizon)
         from "goals"."goals" g
         where g.archived_at is null and g.horizon is not null and g.horizon <= ${day}::date
         order by g.horizon desc
         limit 1) as last_ended,
      (select coalesce(json_agg(jsonb_build_object(
                 'id', g.id,
                 'name', g.name,
                 'horizon', g.horizon
               ) order by g.position, g.created_at, g.id), '[]'::json)
         from "goals"."goals" g
         where g.archived_at is null
           and g.horizon is not null
           and g.horizon > ${weekStart}::date
           and g.horizon <= ${day}::date) as ended_this_week
  `);

  return row;
}

// A source that cannot be read degrades to an empty outcome, never a throw
// (RNP-04): the caller still draws, minus the evidence. Hoy and `/metas` both
// read their figures through this.
export async function readEvidenceOutcome(
  personId: string,
  from: string,
  to: string,
): Promise<EvidenceOutcome> {
  return withReadingDb((tx) => queryEvidenceBySource(tx, personId, from, to)).then(
    (bySourceKey): EvidenceOutcome => ({ status: "read", bySourceKey }),
    (): EvidenceOutcome => ({ status: "unreadable", bySourceKey: {} }),
  );
}

function toCommitmentPlan(row: CommitmentRow): CommitmentPlan {
  return {
    id: row.id,
    cadence: toCadence(row),
    satisfiedBy: toSatisfiedBy(row),
    retiredAt: row.retired_at,
    createdOn: civilDateInZone(new Date(row.created_at)),
  };
}

// `Phase` names no goal: `deriveDay`'s own `phaseOn` picks the
// first span that holds `day` out of every phase across every goal, which is
// only ever right for one goal at a time. `DayScreen` calls that same
// `phaseOn` itself, once per goal, against phases narrowed to that goal by
// this `goalId` — `deriveDay` and `DayView.phase` stay as they are.
export type PhaseInfo = Phase & { goalId: string };

function toPhaseInfo(row: PhaseRow): PhaseInfo {
  return { ...toPhase(row), goalId: row.goal_id };
}

// A goal's own name and measure (RP-11, RP-14), read beside `DayView` rather
// than folded into it: the day engine derives a slot, never a group.
export type GoalSummary = {
  id: string;
  name: string;
  horizon: string | null;
  // The civil day the goal was written, in the person's zone.
  openedOn: string;
  measureName: string | null;
  measureUnit: string | null;
  parentId: string | null;
  // Null for a goal that stands alone: only one with goals under it is a general.
  level: Level | null;
  rootId: string;
};

// One general with the goals under it, or a goal on its own: ids in preorder.
export type DayGroup = { rootId: string; goalIds: string[] };

function toGoalSummary(row: GoalRow, tree: Tree): GoalSummary {
  return {
    id: row.id,
    name: row.name,
    horizon: row.horizon,
    openedOn: civilDateInZone(new Date(row.created_at)),
    measureName: row.measure_name,
    measureUnit: row.measure_unit,
    parentId: tree.byId.has(row.parent_id ?? "") ? row.parent_id : null,
    level: tree.byId.get(row.id)?.level ?? null,
    rootId: rootOf(tree, row.id),
  };
}

function treeOf(goals: GoalRow[]): Tree {
  return buildTree(
    goals.map((goal) => ({
      id: goal.id,
      parentId: goal.parent_id,
      position: goal.position,
      createdAt: goal.created_at,
      name: goal.name,
      horizon: goal.horizon,
      archivedAt: null,
      measureUnit: goal.measure_unit,
    })),
  );
}

// A goal with goals under it has no figures of its own: its line is the sum of
// theirs (RP-80), its own reached amount added (RP-78).
function rolledMonthLines(
  all: GoalRow[],
  tree: Tree,
  lines: Record<string, DayMonthLine>,
  day: string,
): Record<string, DayMonthLine> {
  const month = monthOf(day);
  const own = new Map<string, GoalMonths>();
  for (const [id, line] of Object.entries(lines)) {
    own.set(id, {
      unit: tree.byId.get(id)?.measureUnit ?? null,
      months: new Map([[month, { planned: line.planned, reached: line.reached, ownBudget: line.ownBudget }]]),
    });
  }
  const rolled = rollUp(tree, own);
  const out = { ...lines };
  for (const goal of all) {
    const up = rolled.get(goal.id);
    if (!up) continue;
    delete out[goal.id];
    if (up.unit === null) continue;
    const figure = up.months.get(month) ?? { planned: null, reached: 0 };
    const planned = figure.planned;
    const line = monthLine({
      month,
      today: day,
      budget: planned === null ? null : { month, amount: planned },
      reached: figure.reached,
      rhythm: null,
      openedOn: civilDateInZone(new Date(goal.created_at)),
      horizon: goal.horizon,
    });
    out[goal.id] = { ...line, planned, ownBudget: false };
  }
  return out;
}

// A one-off still owed (RP-19, RP-20): `goalId` is null for one that belongs
// to none, and the screen draws it in its own group below the rest. `day` is
// the one-off's own, not the day drawn — a screen reading `day < view.day`
// is reading a carried one-off, undone since a day before today's; RP-19
// says it rides every day after its own until it is done
// or deleted, never just the one it was written for.
export type OneOffSummary = {
  id: string;
  goalId: string | null;
  name: string;
  day: string | null;
  note: string | null;
};

// A one-off whose fact lands on the day drawn: RP-19's "done stays", read
// back with the fact's id so the screen can undo it.
export type DoneOneOffSummary = {
  id: string;
  goalId: string | null;
  name: string;
  factId: string;
  note: string | null;
  // The instant the fact was written; the screen prints its time of day.
  writtenAt: string;
};

function toOneOffSummary(row: OneOffRow): OneOffSummary {
  return { id: row.id, goalId: row.goal_id, name: row.name, day: row.day, note: row.note };
}

// What a `DaySlot` (`lib/day/types.ts`) does not carry: which goal a
// commitment belongs to, its own name, and the mechanism that satisfies it —
// `DayScreen` groups by the first, names a row with the second, and
// decides a tap's target with the third (a `quantity` row opens the
// quantity sheet instead of calling `declareFact` bare). `target` and `unit`
// ride the same `commitments` row `toSatisfiedBy` already reads (RP-03); null
// for every kind but `quantity`, which is the only one that needs them.
// `cadence` is `toCadence`'s own return (used above to build `CommitmentPlan`
// for `deriveDay`), read a second time here for the row's own second line —
// no new column, no second query: `to_jsonb(c)` already carries every column
// `toCadence` reads.
export type CommitmentInfo = {
  id: string;
  // Null: a habit with no goal (RP-100).
  goalId: string | null;
  name: string;
  kind: SatisfiedBy["kind"];
  target: number | null;
  unit: string | null;
  cadence: Cadence;
  // Evidence commitments only: how many readings satisfy the day, and the
  // catalogue keys naming the source and its unit (RNP-10).
  evidence: { threshold: number; unit: string; labelKey: SourceKey; unitKey: SourceKey } | null;
};

function toCommitmentInfo(row: CommitmentRow): CommitmentInfo {
  return {
    id: row.id,
    goalId: row.goal_id,
    name: row.name,
    kind: row.satisfaction,
    target: row.satisfaction === "quantity" ? row.target_quantity : null,
    unit: row.satisfaction === "quantity" ? row.unit : null,
    cadence: toCadence(row),
    evidence:
      row.satisfaction === "evidence" && row.source_label_key
        ? {
            threshold: row.threshold ?? 1,
            unit: row.source_unit ?? "",
            labelKey: sourceKey(row.source_label_key),
            unitKey: sourceKey(`${row.source_label_key}Unit`),
          }
        : null,
  };
}

// `LoggedFact` and the rule that picks it — the latest write, never the
// first row — live in `lib/day/logged-fact.ts`, pure and DB-free so a plain
// `node:test` can pin that rule with no database behind it.
function toFactForCommitment(row: FactRow) {
  return {
    id: row.id,
    commitmentId: row.commitment_id,
    writtenAt: row.written_at,
    quantity: row.quantity,
    note: row.note,
  };
}

// Every goal with a measure: this month's amount, what was reached in it and
// whether it runs under pace (RP-28, RP-29), over the month's facts by their
// own `goal_id` and evidence in the goal's unit.
export type DayMonthLine = MonthLine & { ownBudget: boolean };

function monthLineOf(
  goals: GoalRow[],
  row: GoalsQueryRow,
  evidenceOutcome: EvidenceOutcome,
  day: string,
): Record<string, DayMonthLine> {
  const month = monthOf(day);
  const lines: Record<string, DayMonthLine> = {};
  for (const goal of goals) {
    const unit = goal.measure_unit;
    if (!unit) continue;
    const facts: DeclaredFact[] = row.facts
      .filter(
        (fact): fact is FactRow & { commitment_id: string } =>
          fact.goal_id === goal.id && fact.commitment_id !== null && fact.day >= month,
      )
      .map(toDeclaredFact);
    const evidence = evidenceDaysFor(
      unit,
      row.measure_sources.filter((source) => source.goal_id === goal.id),
      evidenceOutcome.bySourceKey,
    );
    const budget = row.month_budgets.find((b) => b.goal_id === goal.id && b.month === month);
    const line = monthLine({
      month,
      today: day,
      budget: budget ? { month, amount: budget.amount } : null,
      reached: reachedByMonth({ unit, facts, evidence }).get(month) ?? 0,
      rhythm: goal.rhythm,
      openedOn: civilDateInZone(new Date(goal.created_at)),
      horizon: goal.horizon,
    });
    // The 0 stays for the AI; Hoy reads a share that rounds to 0 as a month
    // with no amount, unless the 0 is a budget the person typed.
    lines[goal.id] = { ...line, ownBudget: budget !== undefined };
  }
  return lines;
}

// What `fillPlan` reads for one goal: every task it holds, the budgets of the
// months from the previous one, and the goal's rhythm.
function planInputOf(goal: GoalRow, row: GoalsQueryRow, day: string): PlanInput {
  const tasks: PlanTask[] = row.goal_tasks
    .filter((task) => task.goal_id === goal.id)
    .map((task) => ({
      id: task.id,
      parentId: task.parent_id,
      name: task.name,
      plannedMonth: task.planned_month,
      day: task.day,
      estimate: task.estimate,
      doneOn: task.done_on,
      note: task.note,
      inPlan: task.in_plan,
      createdOn: civilDateInZone(new Date(task.created_at)),
      position: task.position,
    }));
  return {
    rhythm: goal.rhythm,
    budgets: row.month_budgets
      .filter((budget) => budget.goal_id === goal.id)
      .map((budget) => ({ month: budget.month, amount: budget.amount })),
    tasks,
    openedOn: civilDateInZone(new Date(goal.created_at)),
    horizon: goal.horizon,
    today: day,
  };
}

// The plan's list for the current month, per goal; a goal with none has no key.
function monthItemsOf(goals: GoalRow[], row: GoalsQueryRow, day: string): Record<string, PlanItem[]> {
  const month = monthOf(day);
  const lists: Record<string, PlanItem[]> = {};
  for (const goal of goals) {
    const items = planMonthList(planInputOf(goal, row, day), month);
    if (items.length > 0) lists[goal.id] = items;
  }
  return lists;
}

// The month's tasks done of total per goal, from the same list the screens read.
function monthTaskCountsOf(lists: Record<string, PlanItem[]>): Record<string, { done: number; total: number }> {
  const counts: Record<string, { done: number; total: number }> = {};
  for (const [goalId, items] of Object.entries(lists)) {
    counts[goalId] = { done: items.filter((item) => item.done).length, total: items.length };
  }
  return counts;
}

// The first undone leaf of the plan's list, carried first. A dated task is
// Hoy's own one-off, never the next of the month.
function monthTaskOf(goals: GoalRow[], lists: Record<string, PlanItem[]>): Record<string, MonthTask | null> {
  const tasks: Record<string, MonthTask | null> = {};
  for (const goal of goals) {
    tasks[goal.id] = null;
    for (const item of lists[goal.id] ?? []) {
      if (item.done || item.task.day !== null) continue;
      const leaf =
        item.children.length === 0
          ? item.task
          : item.children
              .filter((child) => child.doneOn === null)
              .sort((a, b) => a.position - b.position)[0];
      if (!leaf) continue;
      tasks[goal.id] = {
        id: leaf.id,
        name: leaf.name,
        estimate: leaf.estimate,
        note: leaf.note ?? null,
        parentName: item.children.length === 0 ? null : item.task.name,
        part: item.part,
      };
      break;
    }
  }
  return tasks;
}

// The notice of a month that closed short, today alone (RP-52, RP-53).
function planNoticeOf(goals: GoalRow[], row: GoalsQueryRow, day: string): Record<string, PlanNotice | null> {
  const notices: Record<string, PlanNotice | null> = {};
  for (const goal of goals) {
    notices[goal.id] = planMoved({ ...planInputOf(goal, row, day), seen: goal.plan_seen });
  }
  return notices;
}

// The goal's measure from the Monday of `day` to `day`: the current row of
// the same `measureByWeek` `loadGoal`'s `weeks` runs, over the week's facts
// of the goal's own commitments and the evidence in its unit, deduped by
// source key the way `lib/queries/goal.ts` does. A goal with no measure has
// no key.
function weekMeasureOf(
  goals: GoalRow[],
  row: GoalsQueryRow,
  evidenceOutcome: EvidenceOutcome,
  day: string,
  weekStart: string,
): Record<string, number> {
  const measure: Record<string, number> = {};
  for (const goal of goals) {
    const unit = goal.measure_unit;
    if (!unit) continue;
    // By the fact's own `goal_id`, as `loadGoal` does: a commitment retired
    // earlier this week still counts what it declared.
    const facts: DeclaredFact[] = row.facts
      .filter(
        (fact): fact is FactRow & { commitment_id: string } =>
          fact.goal_id === goal.id && fact.commitment_id !== null && fact.day >= weekStart,
      )
      .map(toDeclaredFact);
    const evidence = evidenceDaysFor(
      unit,
      row.measure_sources.filter((source) => source.goal_id === goal.id),
      evidenceOutcome.bySourceKey,
    );
    const current = measureByWeek({
      openedOn: civilDateInZone(new Date(goal.created_at)),
      horizon: goal.horizon,
      today: day,
      unit,
      facts,
      evidence,
      phases: [],
    }).find((week) => week.current);
    measure[goal.id] = current?.total ?? 0;
  }
  return measure;
}

/**
 * Feeds the day screen in exactly two transactions, fanned with `Promise
 * .all` and never chained (RNP-03): `withGoalsDb`'s one statement is
 * everything the day derives from, `withReadingDb`'s is every known
 * source's rows for `[day, day]`. The evidence promise is settled here, not
 * awaited bare — a rejection degrades to `"unreadable"` and the declared
 * facts alone decide the day (RNP-04): never a blank day, never an error
 * page.
 *
 * `goals`, `oneOffs` and `commitments` ride out of the same `withGoalsDb`
 * statement `view` is derived from — no third query, still four statements
 * total (`withGoalsDb`'s settle + select, `withReadingDb`'s settle + select).
 * `DayScreen` is what groups a slot under its goal and draws a
 * one-off beneath the last one; `DayView` and `deriveDay` are
 * unchanged.
 *
 * `oneOffs` carries every one-off dated on or before `day` that no fact yet
 * names, whatever day that fact was written on (RP-19):
 * an undone one-off from three days back rides every `loadDay` after its
 * own until it is done or deleted, read here through `o.day <= day` beside
 * the row-level `not exists` the SQL above already runs. `OneOffSummary`
 * still carries its own `day`, unclamped, so a caller can tell a carried one
 * from today's own by comparing it against the day drawn.
 */
export async function loadDay(day: string): Promise<{
  view: DayView;
  evidence: "read" | "unreadable";
  goals: GoalSummary[];
  // The goals in tree order, a group per general or per goal on its own; the
  // screen decides which group goes first.
  groups: DayGroup[];
  oneOffs: OneOffSummary[];
  doneOneOffs: DoneOneOffSummary[];
  daylessCount: number;
  scheduledCount: number;
  // The open-less day's own words: the goal whose end came last (name, horizon).
  lastEnded: { name: string; horizon: string } | null;
  // Goals whose last day fell in the Monday-to-Sunday week of `day`, before
  // `day` itself, most recent first: what Hoy's «terminó ayer» line names.
  endedThisWeek: EndedGoal[];
  weekMeasure: Record<string, number>;
  monthLine: Record<string, DayMonthLine>;
  // Each open goal's next undone leaf of the month, carried first; read on
  // today alone, `{}` on any other day.
  monthTask: Record<string, MonthTask | null>;
  // Tasks of the month, done of total, for every goal that has any; today only.
  monthTaskCounts: Record<string, { done: number; total: number }>;
  // Each open goal's notice that a closed month moved its end; today only, `{}` on any other day.
  planNotice: Record<string, PlanNotice | null>;
  commitments: CommitmentInfo[];
  // Habits with no goal (RP-100), beside the goals: their commitments and the day's slots for them.
  loose: { commitments: CommitmentInfo[]; slots: DaySlot[] };
  // The civil day of the person's oldest goal or loose habit, archived included; null without either.
  firstGoalDay: string | null;
  phases: PhaseInfo[];
  // Each phase's place among its goal's phases, in every phase the goal has.
  phasePositions: Record<string, { ordinal: number; total: number }>;
  factsByCommitment: Record<string, LoggedFact>;
  // Distinct days a flexible commitment has a fact in its week or month, up
  // to `day`; absent for a cadence counted by the day.
  periodDone: Record<string, number>;
}> {
  const person = await getPerson();
  if (!person) throw new Error("loadDay called without a verified session");

  const weekStart = weekOf(day)[0];
  const monthStart = monthOf(day);
  const isToday = day === todayInZone();
  // The month's evidence reaches back past the week's Monday when the month
  // opened earlier; the day's slots still filter their own day below.
  const evidenceFrom = weekStart < monthStart ? weekStart : monthStart;

  const [row, evidenceOutcome] = await Promise.all([
    withGoalsDb((tx) => queryGoalsRow(tx, day, weekStart, isToday)),
    readEvidenceOutcome(person.id, evidenceFrom, day),
  ]);

  const commitments = row.commitments.map(toCommitmentPlan);
  // The statement returns every phase so a goal's phase can say its place
  // among them; what the day derives from stays the ones in effect on `day`.
  const inEffect = row.phases.filter(
    (phase) => phase.starts_on <= day && phase.ends_on >= day,
  );
  const phases = inEffect.map(toPhase);
  // A one-off's fact carries no `commitment_id`; `DeclaredFact` names one
  // that always does, so a one-off's own fact plays no part in deriving a
  // commitment's slot (RP-19's list is this file's own `oneOffs`, read by
  // `DayScreen`).
  const dayFacts = row.facts.filter((fact) => fact.day === day);
  // Every fact of the period, not the day's alone: `asksOn` counts a quota
  // over the week or the month, and `deriveSlot` reads the day's own by day.
  const facts = row.facts
    .filter((fact): fact is FactRow & { commitment_id: string } => fact.commitment_id !== null)
    .map(toDeclaredFact);
  const dayEvidence = Object.fromEntries(
    Object.entries(evidenceOutcome.bySourceKey).map(([key, days]) => [
      key,
      days.filter((d) => d.day === day),
    ]),
  );
  const evidence = toEvidenceByCommitment(row.commitments, dayEvidence);
  const goals = row.goals.filter((goal) => goal.horizon === null || goal.horizon > day);
  // The tree spans every goal the statement returns: one that ended this week
  // still counts in the sum of the general above it.
  const tree = treeOf(row.goals);
  const visible = new Set(goals.map((goal) => goal.id));
  const holders = new Set(tree.order.filter((node) => node.children.length > 0).map((node) => node.id));
  const groups: DayGroup[] = tree.order
    .filter((node) => node.depth === 0 && visible.has(node.id))
    .map((node) => ({ rootId: node.id, goalIds: branchOf(tree, node.id).filter((id) => visible.has(id)) }));
  const monthLines = Object.fromEntries(
    Object.entries(
      rolledMonthLines(row.goals, tree, monthLineOf(row.goals, row, evidenceOutcome, day), day),
    ).filter(([id]) => visible.has(id)),
  );

  const monthItems = isToday ? monthItemsOf(goals, row, day) : null;

  const view = deriveDay({ commitments, phases, facts, evidence, day, today: todayInZone() });
  const infos = row.commitments.map(toCommitmentInfo);
  const looseIds = new Set(infos.filter((info) => info.goalId === null).map((info) => info.id));
  const periodDone: Record<string, number> = {};
  for (const plan of commitments) {
    const done = periodDoneOn(plan.cadence, plan.id, facts, day);
    if (done !== null) periodDone[plan.id] = done;
  }

  // `completeOneOff` never deletes the one-off's own row — it
  // only writes the fact that explains it — so the `one_offs` subquery
  // itself carries the `not exists (... facts ...)` check now (RP-19's
  // "done, it leaves the list", true on any day the fact was written, not
  // only today's): `row.one_offs` already excludes a completed one, no JS
  // filter and no third query needed.
  return {
    view,
    periodDone,
    evidence: evidenceOutcome.status,
    goals: goals.map((goal) => toGoalSummary(goal, tree)),
    groups,
    oneOffs: row.one_offs.map(toOneOffSummary),
    doneOneOffs: row.done_one_offs.map((o) => ({
      id: o.id,
      goalId: o.goal_id,
      name: o.name,
      factId: o.fact_id,
      writtenAt: o.written_at,
      note: o.note,
    })),
    daylessCount: row.dayless_count,
    scheduledCount: row.scheduled_count,
    lastEnded: row.last_ended,
    endedThisWeek: row.ended_this_week.map((goal) => ({
      id: goal.id,
      name: goal.name,
      lastDay: dayBefore(goal.horizon),
    })),
    weekMeasure: weekMeasureOf(goals, row, evidenceOutcome, day, weekStart),
    monthLine: monthLines,
    monthTask: monthItems ? monthTaskOf(goals, monthItems) : {},
    monthTaskCounts: monthItems ? monthTaskCountsOf(monthItems) : {},
    planNotice: isToday ? planNoticeOf(goals.filter((goal) => !holders.has(goal.id)), row, day) : {},
    commitments: infos,
    loose: {
      commitments: infos.filter((info) => info.goalId === null),
      slots: view.slots.filter((slot) => looseIds.has(slot.commitmentId)),
    },
    firstGoalDay: row.first_goal_at ? civilDateInZone(new Date(row.first_goal_at)) : null,
    phases: inEffect.map(toPhaseInfo),
    phasePositions: phasePositions(row.phases.map((phase) => ({ id: phase.id, goalId: phase.goal_id, startsOn: phase.starts_on }))),
    factsByCommitment: latestFactByCommitment(dayFacts.map(toFactForCommitment)),
  };
}
