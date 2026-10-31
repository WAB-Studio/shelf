"use server";

import { revalidatePath } from "next/cache";

import { and, eq, ne, sql } from "drizzle-orm";

import { goals, phases } from "@/db/schema";
import { messageKey, type MessageKey } from "@/i18n/translator";
import { NamedError } from "@/lib/actions/named-error";
import { pgCode } from "@/lib/db-error";
import { evidenceDoneDays } from "@/lib/day/constancy";
import { queryEvidenceBySource } from "@/lib/queries/evidence";
import { getPerson, withGoalsDb, withReadingDb } from "@/lib/session";
import { civilDateInZone, todayInZone } from "@/lib/zone";
import { isClosed } from "@/lib/validation/closed";
import { phasesOverlap, phaseWithinHorizon } from "@/lib/validation/plan";
import {
  deleteCommitmentSchema,
  deletePhaseSchema,
  editCadenceSchema,
  editPhaseSchema,
  renameCommitmentSchema,
} from "@/lib/validation/plan-edit";

export type EditPhaseResult = { ok: true } | { ok: false; error: MessageKey };
export type DeletePhaseResult = { ok: true } | { ok: false; error: MessageKey };
export type EditCadenceResult = { ok: true } | { ok: false; error: MessageKey };
export type RenameCommitmentResult = { ok: true } | { ok: false; error: MessageKey };
export type DeleteCommitmentResult = { ok: true } | { ok: false; error: MessageKey };

// Every screen a phase or a commitment can change what it draws on; a loose habit has its own too.
function revalidateScreens(goalId: string | null, habitId?: string): void {
  revalidatePath("/");
  revalidatePath("/semana");
  revalidatePath("/mes");
  revalidatePath("/metas");
  if (goalId) revalidatePath(`/metas/${goalId}`);
  if (goalId === null && habitId) revalidatePath(`/metas/habitos/${habitId}`);
}

// An explicit `ARRAY[...]::smallint[]`: drizzle expands a bare JS array into a comma list (docs/TRAPS.md).
function weekdaysArraySql(days: number[]) {
  return sql`ARRAY[${sql.join(
    days.map((day) => sql`${day}`),
    sql`, `,
  )}]::smallint[]`;
}

/**
 * Rewrites a phase's aim and span (RP-127, RP-15). Takes the goal's advisory lock first, as `addPhase`
 * does, so two edits into one free span cannot both read «no overlap». The phase is read through the
 * session's policy, so another person's reads as missing; the span is checked against the goal's other
 * phases, never against the phase itself.
 */
export async function editPhase(input: unknown): Promise<EditPhaseResult> {
  const parsed = editPhaseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const { phaseId, aim, startsOn, endsOn } = parsed.data;

  try {
    const goalId = await withGoalsDb(async (tx) => {
      const [owner] = await tx
        .select({ goalId: phases.goalId })
        .from(phases)
        .where(and(eq(phases.id, phaseId), eq(phases.userId, person.id)));
      if (!owner) throw new NamedError("plan.errors.phaseNotFound");

      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${owner.goalId}::text, 0))`);

      const [goal] = await tx
        .select({ horizon: goals.horizon, archivedAt: goals.archivedAt })
        .from(goals)
        .where(eq(goals.id, owner.goalId));
      if (!goal || isClosed(goal)) throw new NamedError("plan.errors.goalNotFound");

      if (!phaseWithinHorizon({ startsOn, endsOn }, goal.horizon)) {
        throw new NamedError("plan.errors.phasePastHorizon");
      }

      const others = await tx
        .select({ startsOn: phases.startsOn, endsOn: phases.endsOn })
        .from(phases)
        .where(and(eq(phases.goalId, owner.goalId), ne(phases.id, phaseId)));
      if (others.some((phase) => phasesOverlap({ startsOn, endsOn }, phase))) {
        throw new NamedError("plan.errors.phaseOverlap");
      }

      const updated = await tx
        .update(phases)
        .set({ aim, startsOn, endsOn })
        .where(and(eq(phases.id, phaseId), eq(phases.userId, person.id)))
        .returning({ id: phases.id });
      // Deleted between the read and the write: the lock is per goal, a delete does not take it.
      if (updated.length === 0) throw new NamedError("plan.errors.phaseNotFound");

      return owner.goalId;
    });

    revalidateScreens(goalId);
    return { ok: true };
  } catch (error) {
    if (error instanceof NamedError) return { ok: false, error: messageKey(error.message) };
    throw error;
  }
}

/**
 * Deletes a phase (RP-127). Nothing depends on a phase, so the refusals are a phase that is not there
 * or not the person's, and a goal that is archived or ended.
 */
export async function deletePhase(input: unknown): Promise<DeletePhaseResult> {
  const parsed = deletePhaseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const { phaseId } = parsed.data;

  try {
    const goalId = await withGoalsDb(async (tx) => {
      const [owner] = await tx
        .select({ goalId: phases.goalId })
        .from(phases)
        .where(and(eq(phases.id, phaseId), eq(phases.userId, person.id)));
      if (!owner) throw new NamedError("plan.errors.phaseNotFound");

      const [goal] = await tx
        .select({ horizon: goals.horizon, archivedAt: goals.archivedAt })
        .from(goals)
        .where(eq(goals.id, owner.goalId));
      if (!goal || isClosed(goal)) throw new NamedError("plan.errors.goalNotFound");

      await tx.delete(phases).where(and(eq(phases.id, phaseId), eq(phases.userId, person.id)));
      return owner.goalId;
    });

    revalidateScreens(goalId);
    return { ok: true };
  } catch (error) {
    if (error instanceof NamedError) return { ok: false, error: messageKey(error.message) };
    throw error;
  }
}

/**
 * Changes the cadence of a commitment or a loose habit no fact names (RP-127, RP-135). One statement
 * reads the row and writes it only while it is live and no fact names it; the guard trigger of 0025
 * answers the same (`42501`) if a fact arrives between the read and the write. What satisfies the
 * commitment and its amount are not columns of this statement.
 */
export async function editCadence(input: unknown): Promise<EditCadenceResult> {
  const parsed = editCadenceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const data = parsed.data;
  const { commitmentId } = data;
  const cadenceN = "cadenceN" in data ? data.cadenceN : null;
  const cadenceWeekdays = "cadenceWeekdays" in data ? weekdaysArraySql(data.cadenceWeekdays) : sql`null`;

  try {
    const [row] = await withGoalsDb((tx) =>
      tx.execute<{
        goal_id: string | null;
        retired: boolean;
        facts: boolean;
        evidence: boolean;
        source_key: string | null;
        threshold: number | null;
        created_at: string;
      }>(sql`
        with t as (
          select c.id, c.goal_id, c.retired_at is not null as retired,
                 exists (select 1 from "goals"."facts" f where f.commitment_id = c.id) as facts,
                 c.satisfaction = 'evidence' as evidence, s.key as source_key, c.threshold, c.created_at
          from "goals"."commitments" c
          left join "goals"."evidence_sources" s on s.id = c.source_id
          where c.id = ${commitmentId} and c.user_id = ${person.id}
        ),
        upd as (
          update "goals"."commitments"
          set cadence_kind = ${data.cadenceKind}, cadence_n = ${cadenceN}, cadence_weekdays = ${cadenceWeekdays}
          where id in (select id from t where not retired and not facts and not evidence)
          returning id
        )
        select goal_id, retired, facts, evidence, source_key, threshold, created_at from t
      `),
    );

    if (!row) return { ok: false, error: "plan.errors.commitmentNotFound" };
    if (row.retired) return { ok: false, error: "plan.errors.commitmentRetired" };
    if (row.facts) return { ok: false, error: "plan.errors.cadenceHasFacts" };
    if (row.evidence) {
      // Evidence writes no fact (RP-05): the days its source met the threshold are days done all the same,
      // so the same refusal stands. An unreadable source cannot say there are none, so it refuses too.
      const days = await withReadingDb((tx) =>
        queryEvidenceBySource(tx, person.id, civilDateInZone(new Date(row.created_at)), todayInZone()),
      ).then(
        (bySourceKey) => evidenceDoneDays({ sourceKey: row.source_key, threshold: row.threshold ?? 1 }, bySourceKey).length,
        () => null,
      );
      if (days === null || days > 0) return { ok: false, error: "plan.errors.cadenceHasFacts" };
      await withGoalsDb((tx) =>
        tx.execute(sql`
          update "goals"."commitments"
          set cadence_kind = ${data.cadenceKind}, cadence_n = ${cadenceN}, cadence_weekdays = ${cadenceWeekdays}
          where id = ${commitmentId} and user_id = ${person.id} and retired_at is null
            and not exists (select 1 from "goals"."facts" f where f.commitment_id = ${commitmentId})
        `),
      );
    }

    revalidateScreens(row.goal_id, commitmentId);
    return { ok: true };
  } catch (error) {
    if (pgCode(error) === "42501") return { ok: false, error: "plan.errors.cadenceHasFacts" };
    throw error;
  }
}

/**
 * Renames a live commitment, whatever facts name it: the facts stay explained and the weeks it governed read
 * as they did. One UPDATE of `name` alone; a retired one and another person's read as not changed.
 */
export async function renameCommitment(input: unknown): Promise<RenameCommitmentResult> {
  const parsed = renameCommitmentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const { commitmentId, name } = parsed.data;

  const [row] = await withGoalsDb((tx) =>
    tx.execute<{ goal_id: string | null; retired: boolean | null; changed: number }>(sql`
      with t as (
        select id, goal_id, retired_at is not null as retired
        from "goals"."commitments" where id = ${commitmentId} and user_id = ${person.id}
      ),
      upd as (
        update "goals"."commitments" set name = ${name}
        where id in (select id from t where not retired)
        returning id
      )
      select (select goal_id from t) as goal_id, (select retired from t) as retired, (select count(*) from upd)::int as changed
    `),
  );

  if (row.changed === 0) {
    return { ok: false, error: row.retired ? "plan.errors.commitmentRetired" : "plan.errors.commitmentNotFound" };
  }

  revalidateScreens(row.goal_id, commitmentId);
  return { ok: true };
}

/**
 * Deletes a commitment or a loose habit no fact names, retired ones too (RP-127). One statement reads
 * the row and its facts and deletes while none names it; `commitments_delete_self` enforces the same
 * rule, so a row that survives is one a fact names.
 */
export async function deleteCommitment(input: unknown): Promise<DeleteCommitmentResult> {
  const parsed = deleteCommitmentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const { commitmentId } = parsed.data;

  const [row] = await withGoalsDb((tx) =>
    tx.execute<{ goal_id: string | null; facts: boolean }>(sql`
      with t as (
        select id, goal_id, exists (select 1 from "goals"."facts" f where f.commitment_id = c.id) as facts
        from "goals"."commitments" c where c.id = ${commitmentId} and c.user_id = ${person.id}
      ),
      del as (
        delete from "goals"."commitments" where id in (select id from t where not facts) returning id
      )
      select goal_id, facts from t
    `),
  );

  if (!row) return { ok: false, error: "plan.errors.commitmentNotFound" };
  if (row.facts) return { ok: false, error: "plan.errors.commitmentHasFacts" };

  revalidateScreens(row.goal_id, commitmentId);
  return { ok: true };
}
