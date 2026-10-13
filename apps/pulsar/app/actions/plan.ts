"use server";

import { revalidatePath } from "next/cache";

import { and, eq, inArray, isNull, max, sql } from "drizzle-orm";

import { commitments, evidenceSources, goals, oneOffs, phases } from "@/db/schema";
import { pgCode } from "@/lib/db-error";
import { isHourUnit, isTimeUnit, storedMeasure } from "@/lib/units/time";
import { buildTree, branchOf, type Tree, type TreeRow } from "@/lib/goals/tree";
import {
  createInsideRefusal,
  branchEndsAfter,
  horizonTreeRefusal,
  moveRefusal,
  type PlacementRefusal,
} from "@/lib/goals/placement";
import { refusalKey, refusalName } from "@/lib/goals/refusal-key";
import { dayBefore } from "@/lib/day/weeks";
import { fillPlan, type PlanTask } from "@/lib/plan/roadmap";
import { getPerson, withGoalsDb, type Transaction } from "@/lib/session";
import { isClosed } from "@/lib/validation/closed";
import { horizonRefusal, moveHorizonSchema, type MoveHorizonInput } from "@/lib/validation/horizon";
import { civilDateInZone, todayInZone } from "@/lib/zone";
import {
  addCommitmentSchema,
  addPhaseSchema,
  archiveGoalSchema,
  createGoalSchema,
  editHabitSchema,
  moveGoalSchema,
  phasesOverlap,
  phaseWithinHorizon,
  renameGoalSchema,
  reopenGoalSchema,
  retireCommitmentSchema,
  setGoalNoteSchema,
  type AddCommitmentInput,
  type AddPhaseInput,
  type ArchiveGoalInput,
  type CreateGoalInput,
  type EditHabitInput,
  type MoveGoalInput,
  type RenameGoalInput,
  type ReopenGoalInput,
  type RetireCommitmentInput,
  type SetGoalNoteInput,
} from "@/lib/validation/plan";
import { messageKey, type MessageKey } from "@/i18n/translator";
import { NamedError } from "@/lib/actions/named-error";

// A refusal of the goal tree names the goal that causes it (`values.name`), and the last day of
// that goal where the words speak of a day.
export type TreeRefusal = { ok: false; error: MessageKey; values?: { name: string; date?: string } };

export type CreateGoalResult = { ok: true; goalId: string } | TreeRefusal;
export type MoveGoalResult = { ok: true } | TreeRefusal;
export type SetGoalNoteResult = { ok: true } | { ok: false; error: MessageKey };
export type AddPhaseResult = { ok: true; phaseId: string } | { ok: false; error: MessageKey };
export type EditHabitResult = { ok: true } | { ok: false; error: MessageKey };
export type AddCommitmentResult =
  | { ok: true; commitmentId: string }
  | { ok: false; error: MessageKey };
export type RetireCommitmentResult = { ok: true } | { ok: false; error: MessageKey };
export type RenameGoalResult = { ok: true } | { ok: false; error: MessageKey };
export type ArchiveGoalResult = { ok: true; archived: number } | { ok: false; error: MessageKey };
export type ReopenGoalResult = { ok: true; reopened: number } | TreeRefusal;
export type MoveHorizonResult = { ok: true } | TreeRefusal;

// Never a bare array parameter — drizzle expands a JS array inside a `sql`
// template into a parenthesised comma list, not a Postgres array literal
// (docs/TRAPS.md, "An array binding is not an array"). Built as an explicit
// `ARRAY[...]::smallint[]` instead, the way `writeCachedAnswer` builds one
// for `text[]`.
function weekdaysArraySql(days: number[]) {
  return sql`ARRAY[${sql.join(
    days.map((day) => sql`${day}`),
    sql`, `,
  )}]::smallint[]`;
}

const INSTANT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

type RawTreeRow = {
  id: string;
  parent_id: string | null;
  position: number;
  created_at: string;
  name: string;
  horizon: string | null;
  archived_at: string | null;
  measure_name: string | null;
  measure_unit: string | null;
  rhythm: number | null;
};

// Every goal of the person in one statement; RLS narrows it. `rhythms` rides along because the
// tree's rows carry none; `measureNames` likewise.
async function readTree(
  tx: Transaction,
): Promise<{ tree: Tree; rhythms: Map<string, number | null>; measureNames: Map<string, string | null> }> {
  const rows = await tx.execute<RawTreeRow>(sql`
    select id, parent_id, position, name, horizon::text as horizon, measure_name, measure_unit, rhythm,
           to_char(created_at at time zone 'UTC', ${sql.raw(INSTANT)}) as created_at,
           to_char(archived_at at time zone 'UTC', ${sql.raw(INSTANT)}) as archived_at
    from ${goals}
  `);
  const list = Array.from(rows);
  const treeRows: TreeRow[] = list.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    position: row.position,
    createdAt: row.created_at,
    name: row.name,
    horizon: row.horizon,
    archivedAt: row.archived_at,
    measureUnit: row.measure_unit,
  }));
  return {
    tree: buildTree(treeRows),
    rhythms: new Map(list.map((row) => [row.id, row.rhythm])),
    measureNames: new Map(list.map((row) => [row.id, row.measure_name])),
  };
}

function refused(refusal: PlacementRefusal): TreeRefusal {
  const error = refusalKey(refusal.code);
  const name = refusalName(refusal);
  if (name === null) return { ok: false, error };
  // Only a goal with an end can be outlasted, so the end read here is never null.
  if (refusal.code === "endPastAbove" && refusal.above.horizon !== null) {
    return { ok: false, error, values: { name, date: dayBefore(refusal.above.horizon) } };
  }
  if (refusal.code === "belowEndsLater" && refusal.below.horizon !== null) {
    return { ok: false, error, values: { name, date: dayBefore(refusal.below.horizon) } };
  }
  return { ok: false, error, values: { name } };
}

const TREE_CONSTRAINTS: Record<string, MessageKey> = {
  goals_tree_cycle: "tree.errors.cycle",
  goals_tree_depth: "tree.errors.tooDeep",
  goals_tree_end: "tree.errors.endPastAbove",
  goals_tree_no_end: "tree.errors.belowNoEnd",
  goals_tree_rhythm: "tree.errors.holderNoRhythm",
  month_budgets_holder: "tree.errors.holderNoBudget",
};

function causeField(error: unknown, field: "constraint_name" | "detail"): string | undefined {
  let current: unknown = error;
  for (let hop = 0; hop < 5 && typeof current === "object" && current !== null; hop++) {
    const value = (current as Record<string, unknown>)[field];
    if (typeof value === "string") return value;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A 23514 of the tree's triggers that slipped past the pure refusals (another door wrote in
// between), said by the constraint it broke. The trigger puts the goal it names in DETAIL; the
// failed transaction is gone, so that goal is read back in a fresh one.
async function treeConstraintRefusal(error: unknown): Promise<TreeRefusal | null> {
  if (pgCode(error) !== "23514") return null;
  const constraint = causeField(error, "constraint_name") ?? "";
  const key = TREE_CONSTRAINTS[constraint];
  if (!key) return null;
  const detail = causeField(error, "detail");
  const [named] = detail && UUID.test(detail)
    ? await withGoalsDb((tx) =>
        tx.execute<{ name: string; horizon: string | null }>(sql`select name, horizon::text as horizon from ${goals} where id = ${detail}`),
      )
    : [];
  if (!named) return { ok: false, error: key };
  const date = constraint === "goals_tree_end" && named.horizon !== null ? { date: dayBefore(named.horizon) } : {};
  return { ok: false, error: key, values: { name: named.name, ...date } };
}

// RP-82/RP-95: every screen that draws the tree, and the page of each goal the act touched.
function revalidateTreeScreens(ids: Iterable<string>): void {
  for (const path of ["/", "/semana", "/metas", "/mes", "/exportar"]) revalidatePath(path);
  for (const id of new Set(ids)) revalidatePath(`/metas/${id}`);
}

// A goal that starts holding goals stops placing its tasks by its rhythm (RP-80): the ones the
// plan had put in a month are fixed to it, in one statement. Reads and writes outside the
// tree's own statements, and only when the goal had a rhythm and no goal inside.
async function fixHolderTasks(tx: Transaction, goalId: string): Promise<void> {
  const [row] = await tx.execute<{
    created_at: string;
    horizon: string | null;
    rhythm: number | null;
    budgets: { month: string; amount: number }[];
    tasks: {
      id: string;
      parent_id: string | null;
      name: string;
      planned_month: string | null;
      day: string | null;
      estimate: number | null;
      done_on: string | null;
      note: string | null;
      in_plan: boolean;
      position: number;
      created_at: string;
    }[];
  }>(sql`
    select g.created_at, g.horizon::text as horizon, g.rhythm,
      (select coalesce(json_agg(jsonb_build_object('month', b.month, 'amount', b.amount)), '[]'::json)
         from "goals"."month_budgets" b where b.goal_id = g.id) as budgets,
      (select coalesce(json_agg(to_jsonb(o) || jsonb_build_object(
                 'done_on', (select min(f.day) from "goals"."facts" f where f.one_off_id = o.id)
               )), '[]'::json)
         from "goals"."one_offs" o where o.goal_id = g.id) as tasks
    from ${goals} g where g.id = ${goalId}
  `);
  if (!row || row.rhythm === null) return;

  const openedOn = civilDateInZone(new Date(row.created_at));
  const tasks: PlanTask[] = row.tasks.map((task) => ({
    id: task.id,
    parentId: task.parent_id,
    name: task.name,
    plannedMonth: task.planned_month,
    day: task.day,
    estimate: task.estimate,
    doneOn: task.done_on,
    note: task.note,
    inPlan: task.in_plan,
    position: task.position,
    createdOn: civilDateInZone(new Date(task.created_at)),
  }));
  const roadmap = fillPlan({
    rhythm: row.rhythm,
    budgets: row.budgets,
    tasks,
    openedOn,
    horizon: row.horizon,
    today: todayInZone(),
  });

  const fixed = new Map<string, string>();
  for (const month of roadmap.months) {
    for (const item of month.items) {
      if (item.fixed || item.done || item.carriedFrom !== null || fixed.has(item.task.id)) continue;
      fixed.set(item.task.id, month.month);
    }
  }
  if (fixed.size === 0) return;

  const payload = JSON.stringify([...fixed].map(([id, month]) => ({ id, month })));
  await tx.execute(sql`
    update ${oneOffs} o set planned_month = v.month::date
    from jsonb_to_recordset(${payload}::jsonb) as v(id uuid, month text)
    where o.id = v.id and o.goal_id = ${goalId} and o.parent_id is null and o.planned_month is null
  `);
}

// Whether `aboveId` holds no open goal yet, so the next one makes it a holder.
function becomesHolder(tree: Tree, aboveId: string): boolean {
  const above = tree.byId.get(aboveId);
  return !!above && above.children.every((id) => tree.byId.get(id)!.archivedAt !== null);
}

const personLock = (personId: string) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${personId}::text, 1))`;

/**
 * Opens a goal with a name and a horizon alone (§0.3, 3; RP-11). The measure
 * columns are never named in this INSERT, so they land null by the shape of
 * the statement — `goals`' INSERT grant does not even list them. Named
 * columns only (docs/TRAPS.md, "Drizzle's insert builder names every
 * column"): `.insert(goals).values()` would name every column of the table
 * and fill `measure_name`/`measure_unit` with the bare word `default`, which
 * the grant refuses just as surely as a real value.
 */
export async function createGoal(input: CreateGoalInput): Promise<CreateGoalResult> {
  const parsed = createGoalSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const { name, horizon, parentId } = parsed.data;

  if (parentId === undefined) {
    const goalId = await withGoalsDb(async (tx) => {
      const [inserted] = await tx.execute<{ id: string }>(sql`
        insert into ${goals} (user_id, name, horizon)
        values (${person.id}, ${name}, ${horizon})
        returning id
      `);

      return inserted.id;
    });

    revalidatePath("/");
    return { ok: true, goalId };
  }

  // Inside another goal: the lock is taken before the tree is read, in its own statement, so the
  // read sees what the previous holder committed (docs/TRAPS.md, advisory lock and snapshot).
  try {
    const outcome = await withGoalsDb(async (tx): Promise<TreeRefusal | { goalId: string }> => {
      await tx.execute(personLock(person.id));
      const { tree, measureNames } = await readTree(tx);
      const above = tree.byId.get(parentId);
      if (!above) return { ok: false, error: "tree.errors.notFound" };
      const refusal = createInsideRefusal(tree, parentId, horizon, todayInZone());
      if (refusal) return refused(refusal);

      const holder = becomesHolder(tree, parentId);
      const [inserted] = await tx.execute<{ id: string }>(sql`
        insert into ${goals} (user_id, name, horizon, parent_id)
        values (${person.id}, ${name}, ${horizon}, ${parentId})
        returning id
      `);
      // The new goal measures what the one above measures, so its rhythm can add up into it. The INSERT grant
      // does not list the measure columns: they land by their own UPDATE.
      const measureName = measureNames.get(parentId);
      if (above.measureUnit !== null && measureName != null) {
        await tx.execute(sql`
          update ${goals} set measure_name = ${measureName}, measure_unit = ${above.measureUnit} where id = ${inserted.id}
        `);
      }
      if (holder) await fixHolderTasks(tx, parentId);
      return { goalId: inserted.id };
    });

    if ("ok" in outcome) return outcome;
    revalidateTreeScreens([outcome.goalId, parentId]);
    return { ok: true, goalId: outcome.goalId };
  } catch (error) {
    const translated = await treeConstraintRefusal(error);
    if (translated) return translated;
    throw error;
  }
}

/**
 * Gives a goal a phase (RP-15). The goal is read back before the insert
 * rather than trusted by id: `phases_insert_self` only checks that the new
 * row's own `user_id` is the caller, never that `goal_id` names one of
 * theirs, so a foreign id would otherwise attach silently. The read runs
 * inside the same settled transaction, so `goals_select_self` — not a `where`
 * this function writes — is what actually hides someone else's goal.
 *
 * The very first statement of the transaction is a `pg_advisory_xact_lock`
 * keyed on this goal's own id (never a migration, an extension or a grant —
 * both functions are built in and callable by any role). Without it, two
 * concurrent `addPhase` calls on the same goal each read "no overlap yet"
 * under `READ COMMITTED` and both insert — driven live, two overlapping spans
 * both landed. The lock serialises every call for one goal: the second one
 * blocks until the first commits or rolls back, then re-reads the phases the
 * first one just wrote and is refused if it overlaps. Released automatically
 * at commit or rollback, never held past this function's own return.
 */
export async function addPhase(input: AddPhaseInput): Promise<AddPhaseResult> {
  const parsed = addPhaseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const { goalId, aim, startsOn, endsOn } = parsed.data;

  try {
    const phaseId = await withGoalsDb(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${goalId}::text, 0))`);

      const [goal] = await tx
        .select({ id: goals.id, horizon: goals.horizon, archivedAt: goals.archivedAt })
        .from(goals)
        .where(eq(goals.id, goalId));
      // Closed reads as not there: `compromisos/nuevo` answers it with a 404.
      if (!goal || isClosed(goal)) throw new NamedError("plan.errors.goalNotFound");

      // A goal names one horizon; a phase is a span of it, never past it.
      if (!phaseWithinHorizon({ startsOn, endsOn }, goal.horizon)) {
        throw new NamedError("plan.errors.phasePastHorizon");
      }

      // Refused here, not by a CHECK: two spans covering one day would make
      // `phaseOn` (lib/day/derive.ts) guess which one a day belongs to.
      const existing = await tx
        .select({ startsOn: phases.startsOn, endsOn: phases.endsOn })
        .from(phases)
        .where(eq(phases.goalId, goalId));
      if (existing.some((phase) => phasesOverlap({ startsOn, endsOn }, phase))) {
        throw new NamedError("plan.errors.phaseOverlap");
      }

      const [inserted] = await tx.execute<{ id: string }>(sql`
        insert into ${phases} (user_id, goal_id, aim, starts_on, ends_on)
        values (${person.id}, ${goalId}, ${aim}, ${startsOn}, ${endsOn})
        returning id
      `);

      return inserted.id;
    });

    revalidatePath("/");
    return { ok: true, phaseId };
  } catch (error) {
    if (error instanceof NamedError) return { ok: false, error: messageKey(error.message) };
    throw error;
  }
}

/**
 * Gives a goal a commitment (RP-12). Like `addPhase`, the goal is read back
 * before the insert so `goals_select_self` — not this function — refuses a
 * foreign id. `sourceKey` is resolved to `evidence_sources.id` inside this
 * same transaction, never a second round trip a caller could race between.
 *
 * When this is the goal's first `quantity` commitment, the same transaction
 * names the goal's measure after it: `goals`' grant permits
 * `UPDATE (measure_name, measure_unit)` alone, and the `WHERE measure_name IS
 * NULL` is what leaves a later quantity commitment's measure untouched — the
 * row is simply not matched a second time (RP-14).
 */
export async function addCommitment(input: AddCommitmentInput): Promise<AddCommitmentResult> {
  const parsed = addCommitmentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const data = parsed.data;

  try {
    const commitmentId = await withGoalsDb(async (tx) => {
      // A habit with no goal reads and touches no goal (RP-100).
      const goalId = data.goalId;
      let goalUnit: string | null = null;
      if (goalId !== undefined) {
        const [goal] = await tx
          .select({
            id: goals.id,
            horizon: goals.horizon,
            archivedAt: goals.archivedAt,
            measureUnit: goals.measureUnit,
          })
          .from(goals)
          .where(eq(goals.id, goalId));
        // Closed reads as not there: `compromisos/nuevo` answers it with a 404.
        if (!goal || isClosed(goal)) throw new NamedError("plan.errors.goalNotFound");
        goalUnit = goal.measureUnit;
      }

      let sourceId: string | null = null;
      if (data.satisfaction === "evidence") {
        const [source] = await tx
          .select({ id: evidenceSources.id })
          .from(evidenceSources)
          .where(eq(evidenceSources.key, data.sourceKey));
        if (!source) throw new NamedError("plan.errors.sourceNotFound");
        sourceId = source.id;
      }

      const cadenceN = "cadenceN" in data ? data.cadenceN : null;
      const cadenceWeekdays = "cadenceWeekdays" in data ? weekdaysArraySql(data.cadenceWeekdays) : sql`null`;
      // A goal that already measures owns the unit: whatever was sent is ignored,
      // except that hours written onto a goal counted in minutes still become minutes.
      let unit: string | null = null;
      let targetQuantity: number | null = null;
      if ("unit" in data && "targetQuantity" in data) {
        const base = goalUnit ?? data.unit;
        if (isTimeUnit(base) && isHourUnit(data.unit) && !isHourUnit(base)) {
          unit = base;
          targetQuantity = data.targetQuantity * 60;
        } else {
          ({ unit, amount: targetQuantity } = storedMeasure(base, data.targetQuantity));
        }
      }
      const threshold = "threshold" in data ? data.threshold : null;

      const [inserted] = await tx.execute<{ id: string }>(sql`
        insert into ${commitments}
          (user_id, goal_id, name, cadence_kind, cadence_n, cadence_weekdays,
           satisfaction, target_quantity, unit, source_id, threshold, note)
        values
          (${person.id}, ${goalId ?? null}, ${data.name}, ${data.cadenceKind}, ${cadenceN},
           ${cadenceWeekdays}, ${data.satisfaction}, ${targetQuantity}, ${unit},
           ${sourceId}, ${threshold}, ${goalId === undefined ? (data.note ?? null) : null})
        returning id
      `);

      if (goalId !== undefined && data.satisfaction === "quantity") {
        await tx
          .update(goals)
          .set({ measureName: data.name, measureUnit: unit })
          .where(and(eq(goals.id, goalId), isNull(goals.measureName)));
      }

      return inserted.id;
    });

    revalidatePath("/");
    return { ok: true, commitmentId };
  } catch (error) {
    if (error instanceof NamedError) return { ok: false, error: messageKey(error.message) };
    // `addCommitmentSchema`'s own `.max()`s refuse an oversized cadenceN,
    // targetQuantity or threshold before the insert runs; this is the second
    // line, the way `declareFact` catches the same code — a number the schema
    // missed for any reason still meets `integer`'s ceiling as a message,
    // never a 500. `pgCode`, not a bare `error.code`: drizzle-orm wraps the
    // driver's error in `DrizzleQueryError` and hangs the real one off
    // `.cause`, so a bare check never fires
    // (`lib/db-error.test.ts` proves the difference).
    if (pgCode(error) === "22003") return { ok: false, error: "plan.errors.valueOutOfRange" };
    throw error;
  }
}

/**
 * Renames a loose habit and rewrites its note (RP-104). One statement: the UPDATE names `name`
 * and `note` alone, and a sibling CTE reads the same row without the `retired_at` filter, so
 * «retired» and «missing» are told apart without a second round trip. A goal's commitment,
 * another person's and a missing id all read as not found.
 */
export async function editHabit(input: EditHabitInput): Promise<EditHabitResult> {
  const parsed = editHabitSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const { commitmentId, name, note } = parsed.data;

  const [outcome] = await withGoalsDb((tx) =>
    tx.execute<{ changed: number; retired: boolean | null }>(sql`
      with found as (
        select retired_at is not null as retired
        from ${commitments}
        where id = ${commitmentId} and user_id = ${person.id} and goal_id is null
      ),
      changed as (
        update ${commitments}
        set name = ${name}, note = ${note}
        where id = ${commitmentId} and user_id = ${person.id}
          and goal_id is null and retired_at is null
        returning id
      )
      select (select count(*) from changed)::int as changed, (select retired from found) as retired
    `),
  );

  if (outcome.changed === 0) {
    return { ok: false, error: outcome.retired ? "plan.errors.habitRetired" : "plan.errors.notFound" };
  }

  revalidatePath("/");
  revalidatePath("/semana");
  revalidatePath("/mes");
  revalidatePath("/metas");
  revalidatePath(`/metas/habitos/${commitmentId}`);
  return { ok: true };
}

/**
 * Retires a commitment (RP-13). One UPDATE of `retired_at` alone — the grant
 * lets nothing else move, so there is no `deleteCommitment` to write in the
 * first place. Scoped by `(id, userId)` in the query itself, the way
 * `undoFact` scopes its delete: a commitment belonging to someone else
 * retires nothing and is reported exactly the way a missing one would be.
 */
export async function retireCommitment(
  input: RetireCommitmentInput,
): Promise<RetireCommitmentResult> {
  const parsed = retireCommitmentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const retired = await withGoalsDb((tx) =>
    tx
      .update(commitments)
      .set({ retiredAt: sql`now()` })
      .where(
        and(eq(commitments.id, parsed.data.commitmentId), eq(commitments.userId, person.id)),
      )
      .returning({ id: commitments.id }),
  );

  if (retired.length === 0) return { ok: false, error: "plan.errors.notFound" };

  revalidatePath("/");
  return { ok: true };
}

// Every screen a goal's own name or its open/archived state can change what
// it draws on: the day, the week, the list and the goal's own screen.
function revalidateGoalScreens(goalId: string): void {
  revalidatePath("/");
  revalidatePath("/semana");
  revalidatePath("/metas");
  revalidatePath(`/metas/${goalId}`);
}

/**
 * Renames a goal (RP-23). One UPDATE of `name` alone, scoped by `(id,
 * userId)` in the query itself, the same shape `retireCommitment` and
 * `undoFact` already take — a foreign id renames nothing and is reported the
 * way a missing one would be. Facts, weeks and commitments never move: `name`
 * is the one column this statement ever names.
 */
export async function renameGoal(input: RenameGoalInput): Promise<RenameGoalResult> {
  const parsed = renameGoalSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const renamed = await withGoalsDb((tx) =>
    tx
      .update(goals)
      .set({ name: parsed.data.name })
      .where(and(eq(goals.id, parsed.data.goalId), eq(goals.userId, person.id)))
      .returning({ id: goals.id }),
  );

  if (renamed.length === 0) return { ok: false, error: "plan.errors.notFound" };

  revalidateGoalScreens(parsed.data.goalId);
  return { ok: true };
}

// A goal and everything below it, walked from `parent_id`.
const branchCte = (goalId: string, personId: string) => sql`
  branch as (
    select id from ${goals} where id = ${goalId} and user_id = ${personId}
    union all
    select g.id from ${goals} g join branch b on g.parent_id = b.id where g.user_id = ${personId}
  )`;

/**
 * Archives a goal and every goal still open below it (RP-24, RP-82) in one statement: the
 * branch is walked from `parent_id` and stamped with one `now()`, so reopening can tell what
 * went with it. Nothing is deleted — facts, phases and commitments keep every row.
 * `archived` counts the goals this call archived; a goal already archived adds none.
 */
export async function archiveGoal(input: ArchiveGoalInput): Promise<ArchiveGoalResult> {
  const parsed = archiveGoalSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const { goalId } = parsed.data;
  const [row] = await withGoalsDb((tx) =>
    tx.execute<{ found: boolean; ids: string[] | null }>(sql`
      with recursive ${branchCte(goalId, person.id)},
      upd as (
        update ${goals} set archived_at = now()
        where id in (select id from branch) and archived_at is null
        returning id
      )
      select exists (select 1 from branch) as found, (select array_agg(id) from upd) as ids
    `),
  );

  if (!row.found) return { ok: false, error: "plan.errors.notFound" };

  const ids = row.ids ?? [];
  revalidateTreeScreens([goalId, ...ids]);
  return { ok: true, archived: ids.length };
}

/**
 * Reopens an archived goal (RP-24) and the goals of its branch archived at the same instant
 * as it, never one archived on its own before (P5 = B), in one statement. A goal under an
 * archived one is refused with that goal's name: it stays archived with its branch.
 */
export async function reopenGoal(input: ReopenGoalInput): Promise<ReopenGoalResult> {
  const parsed = reopenGoalSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const { goalId } = parsed.data;
  const [row] = await withGoalsDb((tx) =>
    tx.execute<{ found: boolean; ids: string[] | null; blocker: string | null }>(sql`
      with recursive ${branchCte(goalId, person.id)},
      up as (
        select g.id, g.parent_id, g.name, g.archived_at, 1 as n
        from ${goals} g
        where g.id = (select parent_id from ${goals} where id = ${goalId}) and g.user_id = ${person.id}
        union all
        select g.id, g.parent_id, g.name, g.archived_at, up.n + 1
        from ${goals} g join up on g.id = up.parent_id
        where g.user_id = ${person.id} and up.n < 8
      ),
      blocker as (select name from up where archived_at is not null order by n limit 1),
      upd as (
        update ${goals} set archived_at = null
        where not exists (select 1 from blocker)
          and id in (select id from branch)
          and archived_at is not null
          and archived_at = (select archived_at from ${goals} where id = ${goalId})
        returning id
      )
      select exists (select 1 from branch) as found,
             (select array_agg(id) from upd) as ids,
             (select name from blocker) as blocker
    `),
  );

  if (!row.found) return { ok: false, error: "plan.errors.notFound" };
  if (row.blocker !== null) return { ok: false, error: refusalKey("aboveArchived"), values: { name: row.blocker } };

  const ids = row.ids ?? [];
  revalidateTreeScreens([goalId, ...ids]);
  return { ok: true, reopened: ids.length };
}

/**
 * Moves a goal under another, or to the top with a null parent (RP-79). The lock is the
 * person's, so two moves that together would make a fourth level are judged one after the
 * other; the tree is read after it, in its own statement. Only `parent_id` is written.
 */
export async function moveGoal(input: MoveGoalInput): Promise<MoveGoalResult> {
  const parsed = moveGoalSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const { goalId, parentId } = parsed.data;

  try {
    const outcome = await withGoalsDb(async (tx): Promise<TreeRefusal | { touched: string[] }> => {
      await tx.execute(personLock(person.id));
      const { tree } = await readTree(tx);
      const goal = tree.byId.get(goalId);
      if (!goal || (parentId !== null && !tree.byId.has(parentId))) return { ok: false, error: "tree.errors.notFound" };

      const refusal = moveRefusal(tree, goalId, parentId, todayInZone());
      if (refusal) return refused(refusal);

      const holder = parentId !== null && becomesHolder(tree, parentId);
      await tx.execute(sql`update ${goals} set parent_id = ${parentId} where id = ${goalId} and user_id = ${person.id}`);
      if (holder) await fixHolderTasks(tx, parentId);
      return { touched: [...branchOf(tree, goalId), ...(goal.parentId ? [goal.parentId] : []), ...(parentId ? [parentId] : [])] };
    });

    if ("ok" in outcome) return outcome;
    revalidateTreeScreens(outcome.touched);
    return { ok: true };
  } catch (error) {
    const translated = await treeConstraintRefusal(error);
    if (translated) return translated;
    throw error;
  }
}

/**
 * Writes a goal's note (RP-95): trimmed, null when blank. One UPDATE of `note` alone, scoped
 * by `(id, userId)`; a foreign id matches nothing and reads as a missing goal.
 */
export async function setGoalNote(input: SetGoalNoteInput): Promise<SetGoalNoteResult> {
  const parsed = setGoalNoteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const written = await withGoalsDb((tx) =>
    tx
      .update(goals)
      .set({ note: parsed.data.note })
      .where(and(eq(goals.id, parsed.data.goalId), eq(goals.userId, person.id)))
      .returning({ id: goals.id }),
  );

  if (written.length === 0) return { ok: false, error: "plan.errors.notFound" };

  revalidateTreeScreens([parsed.data.goalId]);
  return { ok: true };
}

/**
 * Moves a goal's horizon (RP-25). One transaction reads the goal and the last
 * day of its phases, so a horizon that would strand a phase is refused with the
 * data it was judged on. The UPDATE names `horizon` alone, scoped by `(id,
 * userId)`; a foreign id matches nothing and is reported as a missing goal.
 */
export async function moveHorizon(input: MoveHorizonInput): Promise<MoveHorizonResult> {
  const parsed = moveHorizonSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "plan.errors.signedOut" };

  const { goalId, horizon, moveBranch } = parsed.data;

  let touched: string[] = [];
  try {
    const refusal = await withGoalsDb(async (tx): Promise<TreeRefusal | null> => {
      const { tree } = await readTree(tx);
      const goal = tree.byId.get(goalId);
      if (!goal) throw new NamedError("plan.errors.notFound");

      const [last] = await tx
        .select({ endsOn: max(phases.endsOn) })
        .from(phases)
        .where(eq(phases.goalId, goalId));

      const phaseRefusal = horizonRefusal({
        horizon,
        today: todayInZone(),
        lastPhaseEndsOn: last?.endsOn ?? null,
      });
      if (phaseRefusal) throw new NamedError(phaseRefusal);

      const later = moveBranch ? branchEndsAfter(tree, goalId, horizon) : [];
      if (moveBranch) {
        // The branch moves with the goal: only the goal above can still refuse its new end.
        const above = goal.parentId === null ? undefined : tree.byId.get(goal.parentId);
        if (above && above.horizon !== null && (horizon === null || horizon > above.horizon)) {
          return refused({ code: "endPastAbove", above: { id: above.id, name: above.name, horizon: above.horizon } });
        }
        if (horizon !== null && later.length > 0) {
          const ends = await tx
            .select({ goalId: phases.goalId, endsOn: max(phases.endsOn) })
            .from(phases)
            .where(inArray(phases.goalId, later.map((g) => g.id)))
            .groupBy(phases.goalId);
          const lastEnd = new Map(ends.map((e) => [e.goalId, e.endsOn]));
          for (const g of later) {
            const endsOn = lastEnd.get(g.id) ?? null;
            if (endsOn !== null && endsOn > horizon) {
              return { ok: false, error: "tree.errors.branchPhaseAfter", values: { name: g.name, date: endsOn } };
            }
          }
        }
      } else {
        const treeRefusal = horizonTreeRefusal(tree, goalId, horizon);
        if (treeRefusal) return refused(treeRefusal);
      }

      touched = [...branchOf(tree, goalId), ...(goal.parentId ? [goal.parentId] : [])];
      // Deepest first: the tree's trigger judges each row against the rows as they stand.
      for (const depth of [2, 1]) {
        const level = later.filter((g) => tree.byId.get(g.id)!.depth === depth);
        if (level.length === 0) continue;
        await tx
          .update(goals)
          .set({ horizon })
          .where(and(inArray(goals.id, level.map((g) => g.id)), eq(goals.userId, person.id)));
      }
      const moved = await tx
        .update(goals)
        .set({ horizon })
        .where(and(eq(goals.id, goalId), eq(goals.userId, person.id)))
        .returning({ id: goals.id });
      if (moved.length === 0) throw new NamedError("plan.errors.notFound");
      return null;
    });
    if (refusal) return refusal;
  } catch (error) {
    if (error instanceof NamedError) return { ok: false, error: messageKey(error.message) };
    const translated = await treeConstraintRefusal(error);
    if (translated) return translated;
    throw error;
  }

  revalidateGoalScreens(goalId);
  revalidateTreeScreens(touched);
  revalidatePath(`/metas/${goalId}/revision`);
  return { ok: true };
}
