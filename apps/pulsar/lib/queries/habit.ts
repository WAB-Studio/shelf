import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { habitMonths, type HabitMonth } from "@/lib/day/habit-months";
import type { Cadence, SatisfiedBy } from "@/lib/day/types";
import { toCadence, toSatisfiedBy, type CommitmentRow } from "@/lib/queries/rows";
import { withGoalsDb } from "@/lib/session";
import { civilDateInZone, todayInZone } from "@/lib/zone";

// One habit with no goal (RP-100), as its own screen draws it (RP-105).
export type HabitView = {
  id: string;
  name: string;
  note: string | null;
  cadence: Cadence;
  satisfiedBy: SatisfiedBy;
  createdOn: string;
  retiredOn: string | null;
  factDayCount: number;
  months: HabitMonth[];
};

type HabitSqlRow = {
  row: (CommitmentRow & { source_label_key: string | null }) | null;
  months: { month: string; days: number }[];
  weeks: { week: string; days: number }[];
};

/**
 * One loose habit with its done days per month and per week: one transaction, one statement.
 * RLS scopes it to the person; a goal's commitment, another person's or a
 * missing one is `null`.
 */
export async function loadHabit(id: string, today: string = todayInZone()): Promise<HabitView | null> {
  if (!z.uuid().safeParse(id).success) return null;

  const [found] = await withGoalsDb((tx) =>
    tx.execute<HabitSqlRow>(sql`
      select
        (select to_jsonb(c) || jsonb_build_object(
                  'source_key', s.key,
                  'source_unit', s.unit,
                  'source_label_key', s.label_key)
           from "goals"."commitments" c
           left join "goals"."evidence_sources" s on s.id = c.source_id
          where c.id = ${id} and c.goal_id is null) as row,
        (select coalesce(json_agg(jsonb_build_object('month', m.month, 'days', m.days) order by m.month), '[]'::json)
           from (select to_char(date_trunc('month', f.day), 'YYYY-MM-DD') as month, count(distinct f.day)::int as days
                   from "goals"."facts" f
                   join "goals"."commitments" c on c.id = f.commitment_id
                  where f.commitment_id = ${id} and c.goal_id is null
                  group by 1) m) as months,
        (select coalesce(json_agg(jsonb_build_object('week', w.week, 'days', w.days) order by w.week), '[]'::json)
           from (select to_char(date_trunc('week', f.day), 'YYYY-MM-DD') as week, count(distinct f.day)::int as days
                   from "goals"."facts" f
                   join "goals"."commitments" c on c.id = f.commitment_id
                  where f.commitment_id = ${id} and c.goal_id is null
                  group by 1) w) as weeks
    `),
  );
  if (!found?.row) return null;

  const row = found.row;
  const createdOn = civilDateInZone(new Date(row.created_at));
  const retiredOn = row.retired_at ? civilDateInZone(new Date(row.retired_at)) : null;
  const cadence = toCadence(row);
  const daysDoneByMonth = new Map(found.months.map((entry) => [entry.month, entry.days]));
  const daysDoneByWeek = new Map(found.weeks.map((entry) => [entry.week, entry.days]));
  let factDayCount = 0;
  for (const days of daysDoneByMonth.values()) factDayCount += days;
  return {
    id: row.id,
    name: row.name,
    note: row.note ?? null,
    cadence,
    satisfiedBy: toSatisfiedBy(row),
    createdOn,
    retiredOn,
    factDayCount,
    months: habitMonths({ cadence, createdOn, retiredOn, daysDoneByMonth, daysDoneByWeek, today }),
  };
}
