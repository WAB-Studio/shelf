import "server-only";

import { sql } from "drizzle-orm";

import { measureFed } from "@/lib/plan/fact-dependence";
import { nameKey } from "@/lib/import/review";
import type { Cadence, GoalSnapshot } from "@/lib/import/differences";
import { withGoalsDb, type Transaction } from "@/lib/session";

type SnapshotRow = {
  id: string;
  name: string;
  horizon: string | null;
  note: string | null;
  measure_name: string | null;
  measure_unit: string | null;
  measure_fed: boolean;
  rhythm: number | null;
  months: { month: string; amount: number }[];
  phases: { id: string; aim: string; starts_on: string; ends_on: string }[];
  commitments: {
    id: string;
    name: string;
    cadence_kind: Cadence["kind"];
    cadence_weekdays: number[] | null;
    cadence_n: number | null;
    satisfaction: "tap" | "quantity";
    target_quantity: number | null;
    unit: string | null;
    has_facts: boolean;
  }[];
  tasks: {
    id: string;
    name: string;
    estimate: number | null;
    month: string | null;
    done: boolean;
    children: { id: string; name: string; done: boolean }[];
  }[];
};

/**
 * One statement: a snapshot of every open goal of the person whose name is among `names`, for the import to
 * diff a draft against (RP-130). Open is `listGoals`'s rule, not archived. A name is matched as `nameKey`
 * reads it, applied here and bound as one jsonb parameter: a JS array would expand into a parenthesised list.
 * Two open goals of one name both come back; the match, not this read, refuses to guess between them.
 *
 * `tx` is the caller's transaction, so the read sees what that transaction wrote; without it the read opens its own.
 */
export async function loadImportSnapshots(names: string[], tx?: Transaction): Promise<GoalSnapshot[]> {
  const keys = [...new Set(names.map(nameKey))];
  if (keys.length === 0) return [];

  const read = (run: Transaction) =>
    run.execute<{ row: SnapshotRow }>(sql`
      select jsonb_build_object(
        'id', g.id,
        'name', g.name,
        'horizon', g.horizon::text,
        'note', g.note,
        'measure_name', g.measure_name,
        'measure_unit', g.measure_unit,
        'measure_fed', ${measureFed(sql`g.id`)},
        'rhythm', g.rhythm,
        'months', coalesce((
          select jsonb_agg(jsonb_build_object('month', b.month::text, 'amount', b.amount) order by b.month)
          from "goals"."month_budgets" b where b.goal_id = g.id
        ), '[]'::jsonb),
        'phases', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', p.id, 'aim', p.aim, 'starts_on', p.starts_on::text, 'ends_on', p.ends_on::text
          ) order by p.starts_on, p.created_at, p.id)
          from "goals"."phases" p where p.goal_id = g.id
        ), '[]'::jsonb),
        'commitments', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', c.id,
            'name', c.name,
            'cadence_kind', c.cadence_kind,
            'cadence_weekdays', c.cadence_weekdays,
            'cadence_n', c.cadence_n,
            'satisfaction', c.satisfaction,
            'target_quantity', c.target_quantity,
            'unit', c.unit,
            'has_facts', exists (select 1 from "goals"."facts" f where f.commitment_id = c.id)
          ) order by c.position, c.created_at, c.id)
          from "goals"."commitments" c
          where c.goal_id = g.id and c.retired_at is null and c.satisfaction <> 'evidence'
        ), '[]'::jsonb),
        'tasks', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', o.id,
            'name', o.name,
            'estimate', o.estimate,
            'month', o.planned_month::text,
            'done', exists (select 1 from "goals"."facts" f where f.one_off_id = o.id),
            'children', coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', k.id,
                'name', k.name,
                'done', exists (select 1 from "goals"."facts" f where f.one_off_id = k.id)
              ) order by k.position, k.created_at, k.id)
              from "goals"."one_offs" k where k.parent_id = o.id
            ), '[]'::jsonb)
          ) order by o.position, o.created_at, o.id)
          from "goals"."one_offs" o
          where o.goal_id = g.id and o.in_plan and o.parent_id is null
        ), '[]'::jsonb)
      ) as row
      from "goals"."goals" g
      where g.archived_at is null
        and lower(regexp_replace(btrim(normalize(g.name, nfc)), '\\s+', ' ', 'g'))
          in (select jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb))
      order by g.position, g.created_at, g.id
    `);

  const rows = await (tx ? read(tx) : withGoalsDb(read));
  const wanted = new Set(keys);
  return rows
    .filter(({ row }) => wanted.has(nameKey(row.name)))
    .map(({ row }) => ({
      id: row.id,
      name: row.name,
      horizon: row.horizon,
      note: row.note,
      measure: row.measure_name !== null && row.measure_unit !== null ? { name: row.measure_name, unit: row.measure_unit } : null,
      measureFed: row.measure_fed,
      rhythm: row.rhythm,
      months: row.months,
      phases: row.phases.map((p) => ({ id: p.id, aim: p.aim, startsOn: p.starts_on, endsOn: p.ends_on })),
      commitments: row.commitments.map((c) => ({
        id: c.id,
        name: c.name,
        cadence: { kind: c.cadence_kind, weekdays: c.cadence_weekdays, n: c.cadence_n },
        satisfaction: c.satisfaction,
        target: c.target_quantity,
        unit: c.unit,
        hasFacts: c.has_facts,
      })),
      // A task the plan places, with no fixed month, reads as "" so it differs from any month a draft names.
      tasks: row.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        estimate: t.estimate,
        month: t.month ?? "",
        done: t.done,
        children: t.children,
      })),
    }));
}
