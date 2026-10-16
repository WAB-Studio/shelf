import { sql, type SQL } from "drizzle-orm";

import { TIME_ZONE } from "@/lib/zone";

/**
 * The statement that keeps every closed month's plan when a rhythm changes or goes (RP-76). For
 * each closed month of the goal's span with no amount it writes that month's share of `oldRhythm`
 * (`plannedOf`, RP-74: the plan the month was lived against), the integer division its floor.
 * A month with no day of the goal in it (the goal ended before it began) gets no row.
 * Meant as a data-modifying CTE: `ins as (${freezeClosedMonths(...)})`. `goalId` and `oldRhythm`
 * are expressions, so a caller gates it by handing a subquery that yields nothing; a null
 * `oldRhythm` writes nothing.
 */
export function freezeClosedMonths(goalId: SQL, oldRhythm: SQL, today: string): SQL {
  return sql`
    insert into "goals"."month_budgets" (user_id, goal_id, month, amount)
    select g.user_id, g.id, d.first,
           ${oldRhythm} * (least(g.horizon, d.next) - greatest((g.created_at at time zone ${TIME_ZONE})::date, d.first))
             / (d.next - d.first)
    from "goals"."goals" g, generate_series(
      date_trunc('month', (g.created_at at time zone ${TIME_ZONE})::date),
      date_trunc('month', ${today}::date) - interval '1 month',
      interval '1 month'
    ) m, lateral (select m::date as first, (m + interval '1 month')::date as next) d
    where g.id = ${goalId} and ${oldRhythm} is not null
      and least(g.horizon, d.next) > greatest((g.created_at at time zone ${TIME_ZONE})::date, d.first)
    on conflict (goal_id, month) do nothing
    returning 1
  `;
}
