import "server-only";

import { sql } from "drizzle-orm";

import { withGoalsDb } from "@/lib/session";

// What each thing holds now, the «antes» of the change that replaces it.
export type ChangeNames = {
  goals: Map<
    string,
    {
      name: string;
      unit: string | null;
      horizon: string | null;
      hasNote: boolean;
      months: Record<string, number>;
      rhythm: number | null;
    }
  >;
  tasks: Map<string, { name: string; month: string | null; day: string | null; hasNote: boolean }>;
  commitments: Map<string, { name: string; unit: string | null; target: number | null }>;
};

type NameRow =
  | { kind: "goal"; id: string; name: string; unit: string | null; extra: { horizon: string | null; hasNote: boolean; months: Record<string, number>; rhythm: number | null } }
  | { kind: "task"; id: string; name: string; unit: null; extra: { month: string | null; day: string | null; hasNote: boolean } }
  | { kind: "commitment"; id: string; name: string; unit: string | null; extra: { target: number | null } };

// A bound array would expand into a row list; this keeps one parameter per id.
function uuids(list: string[]) {
  if (list.length === 0) return sql`array[]::uuid[]`;
  return sql`array[${sql.join(list.map((id) => sql`${id}::uuid`), sql`, `)}]`;
}

// The names a change touches and the values it replaces, for the chat to show
// before it acts (RP-92). One statement over the tables; RLS leaves out what is
// not the person's.
export async function loadChangeNames(ids: {
  goals: string[];
  tasks: string[];
  commitments: string[];
}): Promise<ChangeNames> {
  const names: ChangeNames = { goals: new Map(), tasks: new Map(), commitments: new Map() };
  if (ids.goals.length + ids.tasks.length + ids.commitments.length === 0) return names;

  const rows = await withGoalsDb((tx) =>
    tx.execute<NameRow>(sql`
      select 'goal' as kind, g.id, g.name, g.measure_unit as unit,
             jsonb_build_object(
               'horizon', g.horizon::text,
               'hasNote', g.note is not null,
               'rhythm', g.rhythm,
               'months', (select coalesce(jsonb_object_agg(to_char(b.month, 'YYYY-MM'), b.amount), '{}'::jsonb)
                            from "goals"."month_budgets" b where b.goal_id = g.id)
             ) as extra
        from "goals"."goals" g where g.id = any(${uuids(ids.goals)})
      union all
      select 'task', o.id, o.name, null::text,
             jsonb_build_object('month', to_char(o.planned_month, 'YYYY-MM'), 'day', o.day::text, 'hasNote', o.note is not null)
        from "goals"."one_offs" o where o.id = any(${uuids(ids.tasks)})
      union all
      select 'commitment', c.id, c.name, c.unit, jsonb_build_object('target', c.target_quantity)
        from "goals"."commitments" c where c.id = any(${uuids(ids.commitments)})
    `),
  );

  for (const row of rows) {
    if (row.kind === "goal") names.goals.set(row.id, { name: row.name, unit: row.unit, ...row.extra });
    else if (row.kind === "task") names.tasks.set(row.id, { name: row.name, ...row.extra });
    else names.commitments.set(row.id, { name: row.name, unit: row.unit, ...row.extra });
  }

  return names;
}
