"use server";

import { revalidatePath } from "next/cache";

import { and, eq, sql } from "drizzle-orm";

import { facts, goals, oneOffs } from "@/db/schema";
import { readReceipt, writeReceipt } from "@/lib/receipts";
import { getPerson, withGoalsDb, type Transaction } from "@/lib/session";
import { monthOutsideSpan, monthStart } from "@/lib/validation/budget";
import { isClosed } from "@/lib/validation/closed";
import { ENDLESS_MONTHS_AHEAD } from "@/lib/plan/months";
import { isTimeUnit, TIME_UNITS } from "@/lib/units/time";
import { civilDateInZone, TIME_ZONE, todayInZone } from "@/lib/zone";
import {
  createOneOffSchema,
  completeOneOffSchema,
  deleteOneOffSchema,
  editTaskSchema,
  fixTaskSchema,
  scheduleOneOffSchema,
  setOneOffNoteSchema,
  type SetOneOffNoteInput,
  type ScheduleOneOffInput,
  type CreateOneOffInput,
  type CompleteOneOffInput,
  type DeleteOneOffInput,
  type EditTaskInput,
  type FixTaskInput,
} from "@/lib/validation/one-off";

import { declareFact, type DeclareFactResult } from "./facts";
import { messageKey, type MessageKey } from "@/i18n/translator";
import { NamedError } from "@/lib/actions/named-error";

export type CreateOneOffResult = { ok: true; oneOffId: string } | { ok: false; error: MessageKey };
export type CompleteOneOffResult = DeclareFactResult;
export type ScheduleOneOffResult = { ok: true } | { ok: false; error: MessageKey };
export type DeleteOneOffResult = { ok: true } | { ok: false; error: MessageKey };
export type SetOneOffNoteResult = { ok: true } | { ok: false; error: MessageKey };
export type EditTaskResult = { ok: true } | { ok: false; error: MessageKey };
export type FixTaskResult = EditTaskResult;

// The key `declareFact` serialises a one-off's fact on: a task's sub-tasks,
// day, estimate and fact are written one transaction at a time. Its own
// statement, so the next read sees what the holder committed (docs/TRAPS.md).
const taskLock = (tx: Transaction, oneOffId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${oneOffId}::text || ':once', 0))`);

// Two sends of one request wait on each other, so the second reads the first's receipt.
const requestLock = (tx: Transaction, requestId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestId}::text || ':request', 0))`);

/**
 * Writes something to do once (RP-19, RP-20), or a task of a goal's month
 * (RP-30, RP-31). `goalId`, when given, is read back before the insert the
 * way `addPhase` reads its own goal back: `one_offs_insert_self` only checks
 * that the new row's `user_id` is the caller, never that `goal_id` names one
 * of theirs, so `goals_select_self` — not this function's own `where` — is
 * what actually hides a foreign goal. A sub-task reads its parent back
 * instead and takes the parent's goal; the policy refuses the same parents,
 * so this read only buys the refusal its key. With a `requestId` (RP-56), a
 * resend answers the first answer and writes nothing.
 */
export async function createOneOff(input: CreateOneOffInput): Promise<CreateOneOffResult> {
  const parsed = createOneOffSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "day.errors.signedOut" };

  const { name, day, estimate, parentId, note, inPlan, requestId } = parsed.data;
  let plannedMonth = parsed.data.plannedMonth;
  // A plain one-off of a goal keeps RP-20's rules; a month's task obeys the goal's plan.
  const isTask = plannedMonth != null || estimate != null || parentId != null || inPlan === true;

  try {
    type Written = { oneOffId: string; goalId: string | null; month: string | null };
    const written = await withGoalsDb(async (tx): Promise<Written | { replay: CreateOneOffResult }> => {
      if (parentId != null) await taskLock(tx, parentId);
      if (requestId !== undefined) {
        await requestLock(tx, requestId);
        const stored = await readReceipt(tx, person.id, requestId);
        if (stored !== null) return { replay: stored as CreateOneOffResult };
      }

      let goalId = parsed.data.goalId ?? null;
      // The month the task counts in: its own, or its parent's.
      let month = plannedMonth ?? null;
      let goal: {
        horizon: string | null;
        archivedAt: Date | null;
        measureUnit: string | null;
        createdAt: Date;
      } | null = null;

      if (parentId != null) {
        const [parent] = await tx
          .select({
            goalId: oneOffs.goalId,
            parentId: oneOffs.parentId,
            day: oneOffs.day,
            estimate: oneOffs.estimate,
            plannedMonth: oneOffs.plannedMonth,
            hasFact: sql<boolean>`exists (select 1 from ${facts} f where f.one_off_id = ${oneOffs}.id)`,
            horizon: goals.horizon,
            archivedAt: goals.archivedAt,
            measureUnit: goals.measureUnit,
            createdAt: goals.createdAt,
          })
          .from(oneOffs)
          .leftJoin(goals, eq(goals.id, oneOffs.goalId))
          .where(eq(oneOffs.id, parentId));
        if (!parent) throw new NamedError("month.errors.notFound");
        if (
          parent.parentId !== null ||
          parent.plannedMonth === null ||
          parent.day !== null ||
          parent.estimate !== null ||
          parent.hasFact ||
          parent.goalId === null ||
          parent.createdAt === null
        ) {
          throw new NamedError("month.errors.parentInvalid");
        }
        goalId = parent.goalId;
        month = parent.plannedMonth.slice(0, 7);
        goal = {
          horizon: parent.horizon,
          archivedAt: parent.archivedAt,
          measureUnit: parent.measureUnit,
          createdAt: parent.createdAt,
        };
      } else if (goalId != null) {
        const [own] = await tx
          .select({
            horizon: goals.horizon,
            archivedAt: goals.archivedAt,
            measureUnit: goals.measureUnit,
            createdAt: goals.createdAt,
          })
          .from(goals)
          .where(eq(goals.id, goalId));
        if (!own) throw new NamedError("plan.errors.goalNotFound");
        goal = own;
        // RP-62: a goal measured in anything but time has no plan to place
        // the task, so it is fixed to its month, the current one when none is named.
        if (day == null && own.measureUnit !== null && !isTimeUnit(own.measureUnit)) {
          // Before the goal opened, the first month of its span.
          const opened = civilDateInZone(own.createdAt).slice(0, 7);
          const current = todayInZone().slice(0, 7);
          plannedMonth ??= current < opened ? opened : current;
          month = plannedMonth;
        }
        // RP-80: a goal holding goals has no rhythm to place a task, so it is fixed to its month too.
        if (day == null && parentId == null && plannedMonth == null) {
          const [holder] = await tx.execute<{ holds: boolean }>(sql`
            select exists (select 1 from ${goals} c where c.parent_id = ${goalId} and c.archived_at is null) as holds
          `);
          if (holder.holds) {
            const opened = civilDateInZone(own.createdAt).slice(0, 7);
            const current = todayInZone().slice(0, 7);
            plannedMonth = current < opened ? opened : current;
            month = plannedMonth;
          }
        }
      }

      if ((isTask || plannedMonth != null) && goal !== null) {
        // DESIGN: a month of an ended or archived goal takes no task.
        if (isClosed(goal)) throw new NamedError("month.errors.closed");
        if (estimate != null && goal.measureUnit === null) {
          throw new NamedError("month.errors.noMeasure");
        }
        if (estimate != null && !isTimeUnit(goal.measureUnit)) {
          throw new NamedError("month.errors.estimateNotTime");
        }
        if (
          plannedMonth != null &&
          monthOutsideSpan({
            month: plannedMonth,
            openedOn: civilDateInZone(goal.createdAt),
            horizon: goal.horizon,
          })
        ) {
          throw new NamedError("month.errors.outsideSpan");
        }
      }

      // Named columns only, never the builder's `.insert()` (docs/TRAPS.md,
      // "Drizzle's insert builder names every column"): `id` and `created_at`
      // are left off, and the grant does not even list `created_at`.
      const [inserted] = await tx.execute<{ id: string }>(sql`
        insert into ${oneOffs} (user_id, goal_id, name, day, estimate, planned_month, parent_id, note, in_plan)
        values (
          ${person.id}, ${goalId}, ${name}, ${day}, ${estimate ?? null},
          ${plannedMonth != null ? monthStart(plannedMonth) : null}, ${parentId ?? null},
          ${note ?? null}, ${inPlan === true}
        )
        returning id
      `);

      if (requestId !== undefined) {
        await writeReceipt(tx, person.id, requestId, "createOneOff", { ok: true, oneOffId: inserted.id });
      }
      return { oneOffId: inserted.id, goalId, month };
    });
    if ("replay" in written) return written.replay;

    revalidatePath("/");
    revalidatePath("/sueltas");
    if (written.goalId !== null && written.month !== null) {
      revalidatePath(`/metas/${written.goalId}/meses/${written.month}`);
    }
    return { ok: true, oneOffId: written.oneOffId };
  } catch (error) {
    if (error instanceof NamedError) return { ok: false, error: messageKey(error.message) };
    throw error;
  }
}

/**
 * Gives a one-off a day, or moves one, dated or not, while it has no fact
 * (RP-59, RP-61). The row is read first only to name the refusal; the
 * enforcement is `not exists (fact)` in the UPDATE, so a fact landing between
 * the two statements still writes nothing — 0 rows is reported as `oneOffHasFact`.
 */
export async function scheduleOneOff(input: ScheduleOneOffInput): Promise<ScheduleOneOffResult> {
  const parsed = scheduleOneOffSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "day.errors.signedOut" };

  const { oneOffId, day } = parsed.data;

  try {
    await withGoalsDb(async (tx) => {
      await taskLock(tx, oneOffId);
      const [row] = await tx
        .select({
          id: oneOffs.id,
          day: oneOffs.day,
          // `${oneOffs}.id`, never `${oneOffs.id}`: a one-table select prints
          // columns bare, and a bare `id` would bind to the subquery's own row.
          hasChildren: sql<boolean>`exists (select 1 from ${oneOffs} c where c.parent_id = ${oneOffs}.id)`,
        })
        .from(oneOffs)
        .where(eq(oneOffs.id, oneOffId));
      if (!row) throw new NamedError("day.errors.notFound");
      // A parent never takes a day (`one_offs_update_self`'s check); this names it.
      if (row.hasChildren) throw new NamedError("month.errors.parentIsDoneByChildren");
      if (row.day === day) return;

      const [existingFact] = await tx
        .select({ id: facts.id })
        .from(facts)
        .where(eq(facts.oneOffId, oneOffId));
      if (existingFact) throw new NamedError("day.errors.oneOffHasFact");

      const updated = await tx
        .update(oneOffs)
        .set({ day })
        .where(
          and(
            eq(oneOffs.id, oneOffId),
            eq(oneOffs.userId, person.id),
            sql`not exists (select 1 from ${facts} where ${facts.oneOffId} = ${oneOffs.id})`,
          ),
        )
        .returning({ id: oneOffs.id });
      if (updated.length === 0) throw new NamedError("day.errors.oneOffHasFact");
    });

    revalidatePath("/");
    revalidatePath("/sueltas");
    revalidatePath("/semana");
    revalidatePath("/mes");
    return { ok: true };
  } catch (error) {
    if (error instanceof NamedError) return { ok: false, error: messageKey(error.message) };
    throw error;
  }
}

/**
 * Takes a one-off off the day's list by writing the fact it produces
 * (RP-19). This is the fact path itself, not a second one: `declareFact`
 * already knows a bare `oneOffId` is one whole subject
 * (`declareFactSchema`'s `requireOneSubject`), reads no commitment and asks
 * no quantity, so calling it here is the entire act. Nothing here inserts
 * into `goals.facts` on its own.
 */
export async function completeOneOff(input: CompleteOneOffInput): Promise<CompleteOneOffResult> {
  const parsed = completeOneOffSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "day.errors.signedOut" };

  const { oneOffId, day } = parsed.data;

  // A parent is done by its sub-tasks (RP-30): `declareFact` refuses one under
  // the task's lock, in the transaction that writes the fact.
  return declareFact({ oneOffId, day }, { namesParent: true });
}

/**
 * Deletes a one-off written by mistake (RP-22): it never happened, so there
 * is no fact to keep. This check is a courtesy, not the enforcement: driven
 * bare, under a settled session with no server action
 * in the way, the old policy let an own one-off with a fact go and the fact
 * cascaded away with it (`facts.one_off_id`'s own FK is `ON DELETE cascade`,
 * `db/schema/facts.ts`, not `restrict` — changing that risks a person's own
 * cascade elsewhere and is out of scope for a migration). The real
 * guard is `one_offs_delete_self` (`db/schema/one-offs.ts`, migration 0002):
 * its own `USING` now refuses a row that carries a fact, so even a write
 * that skips this function entirely — or a fact landing between this check
 * and the statement below — never deletes one. This check only ever buys
 * the sheet its named message before the round trip; the delete itself is
 * the same statement either way.
 */
export async function deleteOneOff(input: DeleteOneOffInput): Promise<DeleteOneOffResult> {
  const parsed = deleteOneOffSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "day.errors.signedOut" };

  const { oneOffId } = parsed.data;

  try {
    const deleted = await withGoalsDb(async (tx) => {
      // One statement names both refusals; a done sub-task's fact is the
      // policy's alone, and its 0 rows read as the own-fact refusal.
      const [found] = await tx
        .select({
          own: sql<boolean>`exists (select 1 from ${facts} where ${facts.oneOffId} = ${oneOffId})`,
          child: sql<boolean>`exists (
            select 1 from ${facts} f join ${oneOffs} c on c.id = f.one_off_id
            where c.parent_id = ${oneOffId}
          )`,
        })
        .from(sql`(select 1) as one`);
      if (found.own) throw new NamedError("day.errors.oneOffHasFact");
      if (found.child) throw new NamedError("month.errors.parentHasDoneChild");

      return tx
        .delete(oneOffs)
        .where(and(eq(oneOffs.id, oneOffId), eq(oneOffs.userId, person.id)))
        .returning({ id: oneOffs.id });
    });

    // A fact this check never saw, written after it and before the
    // statement above: the policy is what actually refused the row, and
    // `deleted.length === 0` is the only sign of that reaching this
    // function — reported as the same refusal, never "not found", since a
    // sheet only ever opens for a one-off the person can already see.
    if (deleted.length === 0) return { ok: false, error: "day.errors.oneOffHasFact" };

    revalidatePath("/");
    return { ok: true };
  } catch (error) {
    if (error instanceof NamedError) return { ok: false, error: messageKey(error.message) };
    throw error;
  }
}

type TaskWrite = {
  oneOffId: string;
  name?: string;
  estimate?: number | null;
  month?: string | null;
};

const REFUSALS: Record<string, MessageKey> = {
  noMeasure: "month.errors.noMeasure",
  estimateNotTime: "month.errors.estimateNotTime",
  invalid: "month.errors.invalid",
  closed: "month.errors.closed",
  doneTask: "roadmap.errors.doneTask",
  subTaskMonth: "roadmap.errors.subTaskMonth",
  dayInMonth: "roadmap.errors.dayInMonth",
  parentEstimate: "roadmap.errors.parentEstimate",
  monthOutsideSpan: "roadmap.errors.monthOutsideSpan",
  monthEnded: "roadmap.errors.monthEnded",
  holderTaskFixed: "tree.errors.holderTaskFixed",
};

/**
 * The one write behind `editTask` and `fixTask` (RP-51, RP-55, RP-57), in one
 * statement under the task's lock, so a sub-task added meanwhile waits for it. The CTEs read one snapshot: `chk` names the first refusal and
 * `upd` writes only when there is none, so a refusal writes nothing and needs
 * no rollback. A task is done when it, or a child, has a fact. A fact or a
 * child landing in between makes `one_offs_guard_day` return 0 rows for an
 * estimate or a month, reported as `doneTask`. A one-off of no goal (RP-57)
 * takes its name alone, and so does a goal's one-off outside the plan.
 */
async function writeTask(input: TaskWrite): Promise<EditTaskResult> {
  const person = await getPerson();
  if (!person) return { ok: false, error: "day.errors.signedOut" };

  const { oneOffId, name, estimate, month } = input;
  const touchesEstimate = estimate !== undefined;
  const touchesMonth = month !== undefined;
  const today = todayInZone();
  const timeUnits = sql`array[${sql.join(
    TIME_UNITS.map((unit) => sql`${unit}`),
    sql`, `,
  )}]::text[]`;

  const rows = await withGoalsDb(async (tx) => {
    await taskLock(tx, oneOffId);
    return tx.execute<{ goal_id: string | null; refusal: string | null; updated: number }>(sql`
      with t as (
        select o.id, o.goal_id, o.parent_id, o.in_plan, o.day,
               exists (
                 select 1 from facts f
                 where f.one_off_id = o.id
                    or f.one_off_id in (select c.id from one_offs c where c.parent_id = o.id)
               ) as has_fact,
               exists (select 1 from one_offs c where c.parent_id = o.id) as has_children,
               g.horizon, g.archived_at, g.measure_unit,
               (g.created_at at time zone ${TIME_ZONE})::date as opened
        from one_offs o left join goals g on g.id = o.goal_id
        where o.id = ${oneOffId} and o.user_id = ${person.id}
      ),
      chk as (
        select t.*,
          case
            when goal_id is null then
              case when ${estimate ?? null}::int is not null then 'noMeasure'
                   when ${touchesMonth}::boolean then 'invalid' end
            when not in_plan and ${touchesEstimate || touchesMonth}::boolean then 'invalid'
            when ${touchesEstimate || touchesMonth}::boolean then
              case
                when has_fact then 'doneTask'
                when ${touchesMonth}::boolean and parent_id is not null then 'subTaskMonth'
                when ${touchesMonth}::boolean and day is not null then 'dayInMonth'
                when ${month ?? null}::text is null and ${touchesMonth}::boolean and exists (
                  select 1 from goals c where c.parent_id = t.goal_id and c.archived_at is null
                ) then 'holderTaskFixed'
                when archived_at is not null or (horizon is not null and horizon <= ${today}::date) then 'closed'
                when ${estimate ?? null}::int is not null and has_children then 'parentEstimate'
                when ${estimate ?? null}::int is not null and measure_unit is null then 'noMeasure'
                when ${estimate ?? null}::int is not null
                  and lower(trim(measure_unit)) <> all(${timeUnits}) then 'estimateNotTime'
                when ${month ?? null}::text is not null and (
                  ${month ? monthStart(month) : null}::date < date_trunc('month', opened)
                  or ${month ? monthStart(month) : null}::date > (
                    case when horizon is not null then date_trunc('month', horizon - 1)
                    else greatest(date_trunc('month', opened),
                                  date_trunc('month', ${today}::date) + ${ENDLESS_MONTHS_AHEAD} * interval '1 month') end
                  )
                ) then 'monthOutsideSpan'
                when ${month ?? null}::text is not null and ${month ?? null}::text < ${today.slice(0, 7)}::text then 'monthEnded'
              end
          end as refusal
        from t
      ),
      upd as (
        update one_offs set
          name = coalesce(${name ?? null}::text, name),
          estimate = case when ${touchesEstimate}::boolean then ${estimate ?? null}::int else estimate end,
          planned_month = case when ${touchesMonth}::boolean then ${month ? monthStart(month) : null}::date else planned_month end
        where id in (select id from chk where refusal is null)
        returning id
      )
      select goal_id, refusal, (select count(*) from upd)::int as updated from chk
    `);
  });

  const row = rows[0];
  if (!row) return { ok: false, error: "plan.errors.notFound" };
  if (row.refusal !== null) return { ok: false, error: REFUSALS[row.refusal] };
  if (row.updated === 0) {
    return { ok: false, error: touchesEstimate || touchesMonth ? "roadmap.errors.doneTask" : "plan.errors.notFound" };
  }

  revalidatePath("/");
  revalidatePath("/sueltas");
  if (row.goal_id !== null) {
    revalidatePath("/mes");
    revalidatePath(`/metas/${row.goal_id}`, "layout");
  }
  return { ok: true };
}

/**
 * The sheet's one act (RP-55, RP-57): name, estimate and month of a plan
 * task, or the name of a suelta. Absent leaves a field; `month: null`
 * returns the task to the plan.
 */
export async function editTask(input: EditTaskInput): Promise<EditTaskResult> {
  const parsed = editTaskSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };
  return writeTask(parsed.data);
}

/** The month half of `editTask`, for the AI (RP-51): fixes, or unfixes with `null`. */
export async function fixTask(input: FixTaskInput): Promise<FixTaskResult> {
  const parsed = fixTaskSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };
  return writeTask(parsed.data);
}

/**
 * Writes, changes or empties a task's note (RP-45), done or not. One UPDATE
 * of `note` alone: it never touches `day` or `planned_month`, so
 * `one_offs_guard_day` lets it through on a done or past row. Another
 * person's row is hidden by `one_offs_update_self` and reads as 0 rows.
 */
export async function setOneOffNote(input: SetOneOffNoteInput): Promise<SetOneOffNoteResult> {
  const parsed = setOneOffNoteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "day.errors.signedOut" };

  const { oneOffId, note } = parsed.data;

  const updated = await withGoalsDb((tx) =>
    tx
      .update(oneOffs)
      .set({ note })
      .where(and(eq(oneOffs.id, oneOffId), eq(oneOffs.userId, person.id)))
      .returning({ goalId: oneOffs.goalId }),
  );
  if (updated.length === 0) return { ok: false, error: "day.errors.notFound" };

  revalidatePath("/");
  revalidatePath("/sueltas");
  revalidatePath("/mes");
  revalidatePath("/metas");
  revalidatePath("/exportar");
  const { goalId } = updated[0];
  if (goalId !== null) revalidatePath(`/metas/${goalId}`, "layout");
  return { ok: true };
}
