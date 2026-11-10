import "server-only";

import { sql } from "drizzle-orm";

import { sharedRows } from "@/lib/evidence/shared-read";
import { planTrayEntries, uncoveredMinutes, type TimelogEntry } from "@/lib/evidence/timelog-tray-plan";
import { getPerson, withGoalsDb, withReadingDb } from "@/lib/session";
import { addDaysToCivilDate, TIME_ZONE, todayInZone } from "@/lib/zone";

import { timeUnit } from "./time-entries";

// Days back, today included, that TimeLog's time is carried to the tray.
const WINDOW_DAYS = 7;

type Covering = { covered: string[]; suggested: string[] };

/**
 * Carries what TimeLog read into Hoy's tray as «por confirmar» entries (RP-151, RP-146). Only the time no TimeLog
 * commitment counts as evidence goes: that time already satisfies its day, and an allocation would count it twice.
 * One entry per day, moved as TimeLog's minutes grow or a commitment starts covering them; minutes the person
 * already placed or dismissed are never entered again. The goal suggested is the one open time goal that holds a
 * TimeLog commitment, when there is exactly one. A TimeLog that cannot be read leaves the tray as it was (RNP-04).
 */
export async function syncTimelogEntries(): Promise<void> {
  const person = await getPerson();
  if (!person) return;
  const to = todayInZone();
  const from = addDaysToCivilDate(to, 1 - WINDOW_DAYS);

  let wanted: { day: string; minutes: number }[];
  let suggested: string | null;
  try {
    const [rows, covering] = await Promise.all([
      withReadingDb((tx) => sharedRows(tx, from, to, TIME_ZONE)),
      withGoalsDb(async (tx): Promise<Covering> => {
        const [row] = await tx.execute<{ covered: string[]; suggested: string[] }>(sql`
          select
            (select coalesce(json_agg(distinct s.key order by s.key), '[]'::json)
               from "goals"."commitments" c
               join "goals"."evidence_sources" s on s.id = c.source_id
               left join "goals"."goals" g on g.id = c.goal_id
              where c.retired_at is null and g.archived_at is null and s.key like 'timelog\_%') as covered,
            (select coalesce(json_agg(distinct g.id order by g.id), '[]'::json)
               from "goals"."commitments" c
               join "goals"."evidence_sources" s on s.id = c.source_id
               join "goals"."goals" g on g.id = c.goal_id
              where c.retired_at is null and g.archived_at is null and s.key like 'timelog\_%' and ${timeUnit}) as suggested
        `);
        return row;
      }),
    ]);
    wanted = uncoveredMinutes(rows.timelog, covering.covered);
    suggested = covering.suggested.length === 1 ? covering.suggested[0] : null;
  } catch {
    return;
  }

  await withGoalsDb(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${person.id}::text || ':timelog-sync', 0))`);
    const entries = await tx.execute<TimelogEntry>(sql`
      select e.id, e.day::text as day, e.minutes,
             (e.dismissed_at is null and not exists (select 1 from "goals"."time_allocations" a where a.entry_id = e.id)) as waiting
        from "goals"."time_entries" e
       where e.source = 'timelog' and e.day between ${from}::date and ${to}::date`);
    for (const step of planTrayEntries(wanted, [...entries])) {
      if (step.kind === "insert") {
        await tx.execute(sql`
          insert into "goals"."time_entries" (user_id, day, minutes, source, suggested_goal_id)
          values (${person.id}, ${step.day}, ${step.minutes}, 'timelog', ${suggested})`);
      } else if (step.kind === "set") {
        await tx.execute(sql`update "goals"."time_entries" set minutes = ${step.minutes} where id = ${step.id}`);
      } else {
        await tx.execute(sql`delete from "goals"."time_entries" where id = ${step.id}`);
      }
    }
  });
}
