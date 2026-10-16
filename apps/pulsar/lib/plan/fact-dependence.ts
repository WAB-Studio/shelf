import { sql, type SQL } from "drizzle-orm";

/**
 * Whether anything the person declared depends on the goal: a fact on the goal, on one of its
 * commitments, on one of its tasks or on a sub-task. The exact predicate of `goals_delete_self`
 * (0025), so the button that offers «Borrar la meta» and the act that refuses share one rule.
 * `goalId` is an expression naming the goal's id: a bound value or a column.
 */
export function goalHasFacts(goalId: SQL): SQL {
  return sql`(
    exists (select 1 from "goals"."facts" f where f.goal_id = ${goalId})
    or exists (
      select 1 from "goals"."commitments" c join "goals"."facts" f on f.commitment_id = c.id
      where c.goal_id = ${goalId}
    )
    or exists (
      select 1 from "goals"."one_offs" o join "goals"."facts" f on f.one_off_id = o.id
      where o.goal_id = ${goalId}
    )
    or exists (
      select 1 from "goals"."one_offs" o
      join "goals"."one_offs" s on s.parent_id = o.id
      join "goals"."facts" f on f.one_off_id = s.id
      where o.goal_id = ${goalId}
    )
  )`;
}

/**
 * Whether the goal's measure is fed (RP-14): a fact of the goal with a quantity of a commitment
 * in the measure's unit, or an evidence commitment of the goal whose source counts in that unit.
 * A done task is no arm: its estimate counts toward no measure (RP-128).
 */
export function measureFed(goalId: SQL): SQL {
  return sql`(
    exists (
      select 1 from "goals"."goals" m
      join "goals"."facts" f on f.goal_id = m.id
      join "goals"."commitments" c on c.id = f.commitment_id
      where m.id = ${goalId} and m.measure_unit is not null
        and f.quantity is not null and c.unit = m.measure_unit
    )
    or exists (
      select 1 from "goals"."goals" m
      join "goals"."commitments" c on c.goal_id = m.id
      join "goals"."evidence_sources" s on s.id = c.source_id
      where m.id = ${goalId} and m.measure_unit is not null
        and c.satisfaction = 'evidence' and s.unit = m.measure_unit
    )
  )`;
}
