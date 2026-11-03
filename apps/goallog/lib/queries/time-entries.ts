import "server-only";

import { sql } from "drizzle-orm";

import { TIME_UNITS } from "@/lib/units/time";
import { withGoalsDb } from "@/lib/session";
import { todayInZone } from "@/lib/zone";

export type WaitingEntry = {
  id: string;
  day: string;
  minutes: number;
  source: "task" | "chat" | "timelog";
  note: string | null;
  // The task it came from; null where it came from the chat or TimeLog, or its task was deleted.
  taskName: string | null;
  suggestedGoalId: string | null;
  suggestedGoalName: string | null;
};

export type TimeGoal = { id: string; name: string };

type WaitingRow = {
  entries: {
    id: string;
    day: string;
    minutes: number;
    source: WaitingEntry["source"];
    note: string | null;
    task_name: string | null;
    suggested_goal_id: string | null;
    suggested_goal_name: string | null;
  }[];
  goals: TimeGoal[];
};

const timeUnit = sql`coalesce(lower(trim(g.measure_unit)) = any(array[${sql.join(TIME_UNITS.map((u) => sql`${u}`), sql`, `)}]::text[]), false)`;

/**
 * Hoy's tray (RP-151): the entries still waiting (not «no cuenta», nothing allocated), oldest first, and the open
 * goals measured in time they can be given to. One statement.
 */
export async function loadWaitingTime(): Promise<{ entries: WaitingEntry[]; totalMinutes: number; goals: TimeGoal[] }> {
  const today = todayInZone();
  const [row] = await withGoalsDb((tx) =>
    tx.execute<WaitingRow>(sql`
      select
        (select coalesce(json_agg(jsonb_build_object(
                   'id', e.id,
                   'day', e.day,
                   'minutes', e.minutes,
                   'source', e.source,
                   'note', e.note,
                   'task_name', o.name,
                   'suggested_goal_id', sg.id,
                   'suggested_goal_name', sg.name
                 ) order by e.created_at, e.id), '[]'::json)
           from "goals"."time_entries" e
           left join "goals"."one_offs" o on o.id = e.one_off_id
           left join "goals"."goals" sg on sg.id = e.suggested_goal_id
           where e.dismissed_at is null
             and not exists (select 1 from "goals"."time_allocations" a where a.entry_id = e.id)) as entries,
        (select coalesce(json_agg(jsonb_build_object('id', g.id, 'name', g.name) order by g.position, g.created_at, g.id), '[]'::json)
           from "goals"."goals" g
           where g.archived_at is null and (g.horizon is null or g.horizon > ${today}::date) and ${timeUnit}) as goals
    `),
  );

  const entries = row.entries.map(
    (entry): WaitingEntry => ({
      id: entry.id,
      day: entry.day,
      minutes: entry.minutes,
      source: entry.source,
      note: entry.note,
      taskName: entry.task_name,
      suggestedGoalId: entry.suggested_goal_id,
      suggestedGoalName: entry.suggested_goal_name,
    }),
  );
  return { entries, totalMinutes: entries.reduce((total, entry) => total + entry.minutes, 0), goals: row.goals };
}

export type TimeLedgerLine = {
  day: string;
  // The goal the minutes went to (confirmed) or are suggested for (waiting); null where nothing is suggested.
  goalId: string | null;
  confirmedMinutes: number;
  waitingMinutes: number;
};

/**
 * Confirmed and waiting time by day and goal over `from`..`to` (RP-151): what a connected AI and the chat read.
 * A «no cuenta» entry is in neither. One statement.
 */
export async function loadTimeLedger(from: string, to: string): Promise<TimeLedgerLine[]> {
  const rows = await withGoalsDb((tx) =>
    tx.execute<{ day: string; goal_id: string | null; confirmed: number; waiting: number }>(sql`
      select day, goal_id, sum(confirmed)::int as confirmed, sum(waiting)::int as waiting
      from (
        select e.day, a.goal_id, a.minutes as confirmed, 0 as waiting
          from "goals"."time_allocations" a
          join "goals"."time_entries" e on e.id = a.entry_id
         where e.dismissed_at is null and e.day between ${from}::date and ${to}::date
        union all
        select e.day, e.suggested_goal_id, 0, e.minutes
          from "goals"."time_entries" e
         where e.dismissed_at is null and e.day between ${from}::date and ${to}::date
           and not exists (select 1 from "goals"."time_allocations" a where a.entry_id = e.id)
      ) t
      group by day, goal_id
      order by day, goal_id
    `),
  );
  return rows.map((row) => ({ day: row.day, goalId: row.goal_id, confirmedMinutes: row.confirmed, waitingMinutes: row.waiting }));
}
