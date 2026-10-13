import "server-only";

import { sql } from "drizzle-orm";

import { withGoalsDb } from "@/lib/session";

export type ChangeNames = {
  goals: Map<string, { name: string; unit: string | null }>;
  tasks: Map<string, { name: string }>;
  commitments: Map<string, { name: string; unit: string | null }>;
};

type NameRow = { kind: "goal" | "task" | "commitment"; id: string; name: string; unit: string | null };

// A bound array would expand into a row list; this keeps one parameter per id.
function uuids(list: string[]) {
  if (list.length === 0) return sql`array[]::uuid[]`;
  return sql`array[${sql.join(list.map((id) => sql`${id}::uuid`), sql`, `)}]`;
}

// The names a change touches, for the chat to show before it acts (RP-92). One
// statement over the three tables; RLS leaves out what is not the person's.
export async function loadChangeNames(ids: {
  goals: string[];
  tasks: string[];
  commitments: string[];
}): Promise<ChangeNames> {
  const names: ChangeNames = { goals: new Map(), tasks: new Map(), commitments: new Map() };
  if (ids.goals.length + ids.tasks.length + ids.commitments.length === 0) return names;

  const rows = await withGoalsDb((tx) =>
    tx.execute<NameRow>(sql`
      select 'goal' as kind, id, name, measure_unit as unit
        from "goals"."goals" where id = any(${uuids(ids.goals)})
      union all
      select 'task', id, name, null::text
        from "goals"."one_offs" where id = any(${uuids(ids.tasks)})
      union all
      select 'commitment', id, name, unit
        from "goals"."commitments" where id = any(${uuids(ids.commitments)})
    `),
  );

  for (const row of rows) {
    if (row.kind === "goal") names.goals.set(row.id, { name: row.name, unit: row.unit });
    else if (row.kind === "task") names.tasks.set(row.id, { name: row.name });
    else names.commitments.set(row.id, { name: row.name, unit: row.unit });
  }

  return names;
}
