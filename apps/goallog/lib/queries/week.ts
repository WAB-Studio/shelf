import "server-only";

import { sql } from "drizzle-orm";

import { deriveWeek } from "@/lib/day/derive";
import { tallyDays, type DayTally } from "@/lib/day/tally";
import type { Cadence, CommitmentPlan, WeekView } from "@/lib/day/types";
import { queryEvidenceBySource } from "@/lib/queries/evidence";
import type { EvidenceOutcome } from "@/lib/queries/evidence";
import {
  livedThrough,
  toCadence,
  toDeclaredFact,
  toEvidenceByCommitment,
  toPhase,
  toSatisfiedBy,
  type CommitmentRow as BaseCommitmentRow,
  type PhaseRow,
} from "@/lib/queries/rows";
import { getPerson, withGoalsDb, withReadingDb, type Transaction } from "@/lib/session";
import { forwardLimit, lastMondayOf } from "@/lib/plan/forward-limit";
import { civilDateInZone, TIME_ZONE, todayInZone, weekOf } from "@/lib/zone";

// `withReadingDb`'s query fans out over `knownSourceKeys()`
// (`lib/evidence/registry.ts`), for the same reason `lib/queries/day.ts`
// does: a set derived from the week's own commitments would only be known
// once the `goals` query resolved, turning this `Promise.all` into the
// chain RNP-03 forbids. A second source costs a reader, a catalogue row and
// one more key in the registry's own map — never a migration (RNP-10).

// The goal's own name, horizon and creation moment: `WeekScreen` groups
// its rows by goal and needs all three to say which week of the plan's own
// horizon this one is (RP-16's overline) — `to_jsonb(g)` already carries every
// column below, so this rides the same statement `commitments`, `phases` and
// `facts` already do.
type GoalRow = {
  id: string;
  name: string;
  // Null: a goal with no end (RP-99).
  horizon: string | null;
  created_at: string;
  archived_at: string | null;
};

// `source_key` / `source_unit` ride in from the join to `evidence_sources`;
// neither column exists on `commitments` itself. `goal_id` widens `rows.ts`'s
// own `CommitmentRow` — `WeekScreen` is what groups a commitment's own
// dot under the goal it belongs to; `deriveWeek` never learns it.
type CommitmentRow = BaseCommitmentRow & { goal_id: string | null };

// `commitment_unit` rides in from the join to `commitments`: a fact carries a
// bare quantity, never its own unit. `one_off_id` and `goal_id` ride in from
// `to_jsonb(f)` itself (RP-20) — a one-off's own fact carries a null
// `commitment_id` and a real `one_off_id`, and `goal_id` is the one-off's own
// goal, copied onto the fact the moment `declareFact` wrote it
// (`app/actions/facts.ts`), null for a one-off that belongs to nothing.
type FactRow = {
  commitment_id: string | null;
  one_off_id: string | null;
  goal_id: string | null;
  day: string;
  written_at: string;
  quantity: number | null;
  note: string | null;
  commitment_unit: string | null;
  one_off_name: string | null;
  one_off_parent_name: string | null;
};

// A not-done one-off dated inside the week, a parent never among them.
export type WeekTask = {
  id: string;
  name: string;
  day: string;
  goalId: string | null;
  goalName: string | null;
  note: string | null;
};

type WeekQueryRow = {
  goals: GoalRow[];
  first_monday: string | null;
  commitments: CommitmentRow[];
  phases: PhaseRow[];
  facts: FactRow[];
  period_facts: { commitment_id: string; day: string }[];
  // Horizons of the goals open today, null for one with no end: what the forward limit reads.
  horizons: (string | null)[];
  tasks: WeekTask[];
};

/**
 * One statement, six subqueries: every open goal, every commitment not
 * retired before the week's own first day (a commitment retired mid-week
 * must still explain the days it lived through), every phase touching the
 * week, and every fact from the first of the Monday's month to the week's
 * Sunday (`loadWeek` narrows what is drawn back to the seven days; the rest
 * only tells a «N al mes» its month is met) — a one-off's own fact
 * included, unfiltered here the same way `lib/queries/day.ts` leaves it
 * (RP-20): the `to_jsonb(f)` already carries `one_off_id` and `goal_id`, so
 * it costs no round trip. No `user_id` filter: RLS alone decides, the same
 * choice `lib/queries/day.ts` and `lib/evidence/reading-lookups.ts` took.
 *
 * `retired_at` is `timestamptz`; `at time zone ${TIME_ZONE}` reads it as the
 * person's own civil day before the `::date` cast, the same fix `lib/queries/
 * day.ts` applies — a bare cast renders in the session's zone (UTC), which
 * would keep a commitment retired after 19:00 Bogotá live one day too long.
 *
 * `period_facts` is the sixth subquery of the same statement: every
 * commitment fact from the first of `anyDay`'s month to the last of it or of
 * the week, whichever reaches further. A flexible cadence's «N de M» counts
 * inside its period, and «al mes» reaches days the week's own `facts` never
 * read. No extra round trip.
 *
 * `goals` are those that governed the week (RP-24, RP-44): written on or
 * before its Sunday, not ended before it began, and not archived before
 * its Sunday — so an archive since keeps the past week it lived through, and
 * a goal opened later never enters it. A goal that ended mid-week stays, it
 * lived through the days before. `first_monday` is the Monday of the oldest
 * goal's or loose habit's creation, archived included: the bound of the screen's ‹.
 * `WeekScreen` only ever groups a dot under a goal it finds here, and
 * `goals.length === 0` is what decides the week's own empty state (`empty-week.tsx`).
 */
async function queryGoalsRow(
  tx: Transaction,
  weekStart: string,
  weekEnd: string,
  anyDay: string,
  today: string,
): Promise<WeekQueryRow> {
  const [row] = await tx.execute<WeekQueryRow>(sql`
    select
      (select coalesce(json_agg(to_jsonb(g) order by g.position, g.created_at, g.id), '[]'::json)
         from "goals"."goals" g
         where (g.created_at at time zone ${TIME_ZONE})::date <= ${weekEnd}::date
           and (g.horizon is null or g.horizon > ${weekStart}::date)
           and ${livedThrough("g", weekEnd)}) as goals,
      (select date_trunc('week', min(t.created_at at time zone ${TIME_ZONE}))::date::text
         from (
           select g.created_at from "goals"."goals" g
           union all
           select c.created_at from "goals"."commitments" c where c.goal_id is null
         ) t) as first_monday,
      (select coalesce(json_agg(to_jsonb(c) || jsonb_build_object(
                 'source_key', s.key,
                 'source_unit', s.unit
               ) order by c.position, c.created_at, c.id), '[]'::json)
         from "goals"."commitments" c
         left join "goals"."evidence_sources" s on s.id = c.source_id
         where c.retired_at is null or (c.retired_at at time zone ${TIME_ZONE})::date >= ${weekStart}::date) as commitments,
      (select coalesce(json_agg(to_jsonb(p) order by p.starts_on, p.created_at, p.id), '[]'::json)
         from "goals"."phases" p
         where p.starts_on <= ${weekEnd}::date
           and p.ends_on >= ${weekStart}::date) as phases,
      (select coalesce(json_agg(to_jsonb(f) || jsonb_build_object(
                 'commitment_unit', c.unit,
                 'one_off_name', o.name,
                 'one_off_parent_name', p.name
               ) order by f.day, f.written_at, f.id), '[]'::json)
         from "goals"."facts" f
         left join "goals"."commitments" c on c.id = f.commitment_id
         left join "goals"."one_offs" o on o.id = f.one_off_id
         left join "goals"."one_offs" p on p.id = o.parent_id
         where f.day between least(${weekStart}::date, date_trunc('month', ${weekStart}::date)::date) and ${weekEnd}::date) as facts,
      (select coalesce(json_agg(json_build_object('commitment_id', f.commitment_id, 'day', f.day)), '[]'::json)
         from "goals"."facts" f
         where f.commitment_id is not null
           and f.day >= least(${weekStart}::date, date_trunc('month', ${anyDay}::date)::date)
           and f.day <= greatest(${weekEnd}::date, (date_trunc('month', ${anyDay}::date) + interval '1 month - 1 day')::date)) as period_facts,
      (select coalesce(json_agg(g.horizon::text), '[]'::json)
         from "goals"."goals" g
         where g.archived_at is null and (g.horizon is null or g.horizon > ${today}::date)) as horizons,
      (select coalesce(json_agg(jsonb_build_object(
                 'id', o.id,
                 'name', o.name,
                 'day', o.day,
                 'goalId', o.goal_id,
                 'goalName', g.name,
                 'note', o.note
               ) order by o.day, o.position, o.created_at, o.id), '[]'::json)
         from "goals"."one_offs" o
         left join "goals"."goals" g on g.id = o.goal_id
         where o.day between ${weekStart}::date and ${weekEnd}::date
           -- A goal's task counts while its goal is open on the task's own day.
           and (o.goal_id is null or (g.archived_at is null and (g.horizon is null or g.horizon > o.day)))
           and not exists (select 1 from "goals"."facts" f where f.one_off_id = o.id)
           and not exists (select 1 from "goals"."one_offs" c where c.parent_id = o.id)) as tasks
  `);

  return row;
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

// A goal's own name and horizon (RP-16's overline), read beside `WeekView`
// rather than folded into it: the week engine derives a slot, never a group.
export type GoalSummary = {
  id: string;
  name: string;
  horizon: string | null;
  createdAt: string;
  // Set only on a goal archived after the week read (RP-24).
  archivedAt: string | null;
};

function toGoalSummary(row: GoalRow): GoalSummary {
  return {
    id: row.id,
    name: row.name,
    horizon: row.horizon,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

// Which goal a commitment's own dots belong to, and its name for the dot's
// own label: `deriveWeek` derives a slot keyed by `commitmentId`
// alone, never a group — this is the one place that maps a slot back to the
// goal section it draws under.
export type CommitmentGoal = {
  id: string;
  // Null: a habit with no goal (RP-100).
  goalId: string | null;
  name: string;
  cadence: Cadence;
  // Distinct days with a fact inside the cadence's own period (this week for
  // `times_per_week`, `anyDayInIt`'s month for `times_per_month`); null for
  // every other cadence, which counts by the day.
  periodDone: number | null;
};

function toCommitmentGoal(
  row: CommitmentRow,
  periodFacts: WeekQueryRow["period_facts"],
  week: string[],
  month: string,
): CommitmentGoal {
  const cadence = toCadence(row);
  const inPeriod =
    cadence.kind === "times_per_week"
      ? (day: string) => week.includes(day)
      : cadence.kind === "times_per_month"
        ? (day: string) => day.slice(0, 7) === month
        : null;
  const periodDone = inPeriod
    ? new Set(periodFacts.filter((f) => f.commitment_id === row.id && inPeriod(f.day)).map((f) => f.day)).size
    : null;
  return { id: row.id, goalId: row.goal_id, name: row.name, cadence, periodDone };
}

// A one-off's own fact (RP-20): `goalId` is the one-off's own, copied onto
// the fact the moment it was completed (`declareFact`, `app/actions/
// facts.ts`), and null for a one-off that belongs to nothing — RP-20's own
// text says the week still shows it, with no goal section to draw it under.
export type OneOffFact = {
  oneOffId: string;
  name: string;
  day: string;
  goalId: string | null;
  // The parent task's name for a sub-task; null for a top-level or goalless one.
  parentName: string | null;
};

/**
 * Feeds the week screen in exactly two transactions, fanned with `Promise
 * .all` and never chained (RNP-03) — the same abanico as `lib/queries/
 * day.ts`'s `loadDay`, over the seven civil days `anyDayInIt` sits in rather
 * than one. The evidence promise is settled here, not awaited bare: a
 * rejection degrades to `"unreadable"` and `deriveWeek` derives all seven
 * days from the declared facts alone (RNP-04).
 *
 * `goals`, `commitments` and `oneOffFacts` ride out of the same
 * `withGoalsDb` statement `view` is derived from — no third query, still
 * four statements total, exactly as `lib/queries/day.ts`'s own comment
 * counts them. `WeekScreen` is what groups a day's dots under the
 * goal they belong to and draws a goalless one under its own "Sueltas"
 * group; `WeekView` and `deriveWeek` are unchanged.
 */
export async function loadWeek(anyDayInIt: string, today: string = todayInZone()): Promise<{
  view: WeekView;
  evidence: "read" | "unreadable";
  goals: GoalSummary[];
  firstMonday: string | null;
  commitments: CommitmentGoal[];
  // Habits with no goal (RP-100): their commitments and the week's tally for them, a day each.
  loose: { commitments: CommitmentGoal[]; days: DayTally[] };
  oneOffFacts: OneOffFact[];
  // The last Monday «Semana» steps forward to (RP-142).
  lastMonday: string;
  // Not-done one-offs dated inside the week, parents excluded: what a coming week offers «Darle día» on.
  tasks: WeekTask[];
}> {
  const person = await getPerson();
  if (!person) throw new Error("loadWeek called without a verified session");

  const week = weekOf(anyDayInIt);
  const weekStart = week[0];
  const weekEnd = week[6];

  const coming = weekStart > weekOf(today)[0];
  const [row, evidenceOutcome] = await Promise.all([
    withGoalsDb((tx) => queryGoalsRow(tx, weekStart, weekEnd, anyDayInIt, today)),
    withReadingDb((tx) => queryEvidenceBySource(tx, person.id, weekStart, weekEnd)).then(
      // A week not yet lived has no evidence; the statement still runs so the count holds.
      (bySourceKey): EvidenceOutcome => ({ status: "read", bySourceKey: coming ? {} : bySourceKey }),
      (): EvidenceOutcome => ({ status: "unreadable", bySourceKey: {} }),
    ),
  ]);

  const commitments = row.commitments.map(toCommitmentPlan);
  const phases = row.phases.map(toPhase);
  // A one-off's fact carries no `commitment_id`; `DeclaredFact` names one
  // that always does, so a one-off's own fact plays no part in deriving a
  // commitment's slot (RP-20's own dot is `oneOffFacts` below, read by
  // `WeekScreen`, never by `deriveWeek`) — the same filter `lib/queries/day.ts` applies.
  const monthFacts = row.facts
    .filter((fact): fact is FactRow & { commitment_id: string } => fact.commitment_id !== null)
    .map(toDeclaredFact);
  const weekFacts = monthFacts.filter((fact) => fact.day >= weekStart);
  const evidence = toEvidenceByCommitment(row.commitments, evidenceOutcome.bySourceKey);

  // What asks comes from the month's facts; what is drawn comes from the
  // week's own, so a tap made after a month was met stays «hecho» though its
  // day no longer asks. The week-only derivation asks a superset of the other.
  const asking = deriveWeek({ commitments, phases, facts: monthFacts, evidence, day: anyDayInIt });
  const drawn = deriveWeek({ commitments, phases, facts: weekFacts, evidence, day: anyDayInIt });
  const view: WeekView = {
    ...drawn,
    days: drawn.days.map((dayView, i) => {
      const asked = new Set(asking.days[i].slots.map((slot) => slot.commitmentId));
      return {
        ...dayView,
        slots: dayView.slots.filter((slot) => asked.has(slot.commitmentId) || slot.satisfied || slot.partial),
      };
    }),
  };

  const placed = row.commitments.map((c) => toCommitmentGoal(c, row.period_facts, week, anyDayInIt.slice(0, 7)));
  const looseCommitments = placed.filter((c) => c.goalId === null);

  return {
    view,
    evidence: evidenceOutcome.status,
    goals: row.goals.map(toGoalSummary),
    firstMonday: row.first_monday,
    lastMonday: lastMondayOf(forwardLimit({ horizons: row.horizons, today })),
    tasks: row.tasks,
    commitments: placed,
    loose: {
      commitments: looseCommitments,
      days: tallyDays({ view, goals: [], commitments: looseCommitments }),
    },
    // Unfiltered by `commitment_id`, unlike `facts` above: a one-off's fact
    // is exactly the row `facts` throws away (RP-19's own shape — "one
    // subject" means never both), read back out here instead.
    oneOffFacts: row.facts
      .filter((fact) => fact.one_off_id !== null && fact.day >= weekStart)
      .map((fact) => ({
        oneOffId: fact.one_off_id as string,
        name: fact.one_off_name ?? "",
        day: fact.day,
        goalId: fact.goal_id,
        parentName: fact.one_off_parent_name,
      })),
  };
}
