"use server";

import { revalidatePath } from "next/cache";

import { sql } from "drizzle-orm";

import { messageKey, type MessageKey } from "@/i18n/translator";
import { pgCode } from "@/lib/db-error";
import { goalHasFacts, measureFed } from "@/lib/plan/fact-dependence";
import { getPerson, withGoalsDb } from "@/lib/session";
import { storedMeasure } from "@/lib/units/time";
import {
  changeGoalMeasureSchema,
  deleteGoalSchema,
  removeGoalMeasureSchema,
} from "@/lib/validation/goal-edit";

export type DeleteGoalResult = { ok: true } | { ok: false; error: MessageKey };
export type ChangeGoalMeasureResult = { ok: true } | { ok: false; error: MessageKey };
export type RemoveGoalMeasureResult = { ok: true } | { ok: false; error: MessageKey };

function revalidateAfterEdit(goalId: string): void {
  revalidatePath(`/metas/${goalId}`, "layout");
  revalidatePath("/metas");
  revalidatePath("/");
}

/**
 * Deletes a goal no fact depends on (RP-127), with its phases, commitments, tasks and month
 * amounts, archived or ended included. `goalHasFacts` is the predicate the delete policy of 0025
 * enforces, read in the statement that deletes, so a refusal can say why where the policy alone
 * would only match no row. A goal holding a goal, archived ones too, is refused; the parent key
 * answers the same (23503) if a child arrives between the read and the delete.
 */
export async function deleteGoal(input: unknown): Promise<DeleteGoalResult> {
  const parsed = deleteGoalSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const { goalId } = parsed.data;
  try {
    const rows = await withGoalsDb((tx) =>
      tx.execute<{ facts: boolean; holder: boolean }>(sql`
        with t as (
          select id,
                 ${goalHasFacts(sql`t0.id`)} as facts,
                 exists (select 1 from "goals"."goals" c where c.parent_id = t0.id) as holder
          from "goals"."goals" t0 where t0.id = ${goalId} and t0.user_id = ${person.id}
        ),
        del as (
          delete from "goals"."goals" where id in (select id from t where not facts and not holder) returning id
        )
        select facts, holder from t
      `),
    );
    const goal = rows[0];
    if (!goal) return { ok: false, error: "plan.errors.goalNotFound" };
    if (goal.facts) return { ok: false, error: "plan.errors.goalHasFacts" };
    if (goal.holder) return { ok: false, error: "plan.errors.goalHoldsGoals" };
  } catch (error) {
    if (pgCode(error) === "23503") return { ok: false, error: "plan.errors.goalHoldsGoals" };
    throw error;
  }

  revalidateAfterEdit(goalId);
  return { ok: true };
}

type MeasureRow = { measured: boolean; holder: boolean; fed: boolean };

// What stands between a measure and its change, read in the statement that writes it.
const measureGate = (goalId: string, userId: string) => sql`
  select id, measure_unit,
         measure_unit is not null as measured,
         exists (select 1 from "goals"."goals" c where c.parent_id = t0.id and c.archived_at is null) as holder,
         ${measureFed(sql`t0.id`)} as fed
  from "goals"."goals" t0 where t0.id = ${goalId} and t0.user_id = ${userId}
`;

function measureRefusal(goal: MeasureRow | undefined): MessageKey | null {
  if (!goal) return "plan.errors.goalNotFound";
  if (!goal.measured) return "plan.errors.noMeasure";
  if (goal.holder) return "plan.errors.holderNoMeasure";
  if (goal.fed) return "plan.errors.measureFed";
  return null;
}

/**
 * Changes the measure of a goal no fact feeds (RP-134): the person may; the AI's `set_measure`
 * still refuses a set measure. A new name alone keeps the rhythm and the month amounts; a new
 * stored unit (hours are kept as minutes, RP-66) clears the rhythm and every month amount of the
 * goal in the same statement, since they were written in the old one.
 */
export async function changeGoalMeasure(input: unknown): Promise<ChangeGoalMeasureResult> {
  const parsed = changeGoalMeasureSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const { goalId, name } = parsed.data;
  const { unit } = storedMeasure(parsed.data.unit, null);

  const rows = await withGoalsDb((tx) =>
    tx.execute<MeasureRow>(sql`
      with t as (${measureGate(goalId, person.id)}),
      eligible as (select id, measure_unit from t where measured and not holder and not fed),
      upd as (
        update "goals"."goals" set measure_name = ${name}, measure_unit = ${unit},
          rhythm = case when measure_unit = ${unit} then rhythm else null end
        where id in (select id from eligible) returning id
      ),
      del as (
        delete from "goals"."month_budgets"
        where goal_id in (select id from eligible where measure_unit <> ${unit}) returning 1
      )
      select measured, holder, fed from t
    `),
  );

  const refusal = measureRefusal(rows[0]);
  if (refusal) return { ok: false, error: refusal };

  revalidateAfterEdit(goalId);
  return { ok: true };
}

/**
 * Takes the measure off a goal no fact feeds (RP-134): its name, unit and rhythm, and every
 * month amount, which were written in that unit.
 */
export async function removeGoalMeasure(input: unknown): Promise<RemoveGoalMeasureResult> {
  const parsed = removeGoalMeasureSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const { goalId } = parsed.data;
  const rows = await withGoalsDb((tx) =>
    tx.execute<MeasureRow>(sql`
      with t as (${measureGate(goalId, person.id)}),
      eligible as (select id from t where measured and not holder and not fed),
      upd as (
        update "goals"."goals" set measure_name = null, measure_unit = null, rhythm = null
        where id in (select id from eligible) returning id
      ),
      del as (
        delete from "goals"."month_budgets" where goal_id in (select id from eligible) returning 1
      )
      select measured, holder, fed from t
    `),
  );

  const refusal = measureRefusal(rows[0]);
  if (refusal) return { ok: false, error: refusal };

  revalidateAfterEdit(goalId);
  return { ok: true };
}
