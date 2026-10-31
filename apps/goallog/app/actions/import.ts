"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { sql, type SQL } from "drizzle-orm";

import { commitments, facts, goals, monthBudgets, oneOffs, phases } from "@/db/schema";
import { pgCode } from "@/lib/db-error";
import { differences, fingerprint, matchGoals, type Difference, type GoalSnapshot } from "@/lib/import/differences";
import { draftRefusals, strayEstimates, withCutPhases, type DraftGoal } from "@/lib/import/draft";
import { nameKey } from "@/lib/import/review";
import { measureFed } from "@/lib/plan/fact-dependence";
import { freezeClosedMonths } from "@/lib/plan/rhythm-freeze";
import { loadImportSnapshots } from "@/lib/queries/import-match";
import { readReceipt, writeReceipt } from "@/lib/receipts";
import { getPerson, withGoalsDb, type Transaction } from "@/lib/session";
import { isTimeUnit, TIME_UNITS } from "@/lib/units/time";
import { monthStart } from "@/lib/validation/budget";
import { importUpdateSchema } from "@/lib/validation/import-update";
import { todayInZone } from "@/lib/zone";
import { messageKey, type MessageKey } from "@/i18n/translator";

// A part the table refused after everything the review checks: its path in the draft, its name, and why.
export type FailedPart = { path: string; name: string; reason: MessageKey };

// `goalIds` are the goals created; `updatedIds` the open goals the review matched and this updated (RP-130).
export type ConfirmImportResult =
  | { ok: true; goalIds: string[]; updatedIds: string[]; failed: FailedPart[] }
  | { ok: false; error: MessageKey; at?: string };

// A row of one multi-row statement, kept with what names it if the table refuses it.
type Part = { row: SQL; path: string; name: string };

const CONSTRAINT_REASONS: Record<string, MessageKey> = {
  commitments_weekdays_for_weekdays: "import.errors.cadenceWeekdays",
  commitments_n_for_counted_kinds: "import.errors.cadenceCount",
  commitments_quantity_for_quantity: "import.errors.quantityNoAmount",
  one_offs_note_shape: "import.errors.noteShape",
};

function reasonOf(error: unknown): MessageKey {
  let current: unknown = error;
  for (let hop = 0; hop < 5 && typeof current === "object" && current !== null; hop++) {
    const name = (current as Record<string, unknown>).constraint_name;
    if (typeof name === "string") return CONSTRAINT_REASONS[name] ?? "import.errors.partFailed";
    current = (current as { cause?: unknown }).cause;
  }
  return "import.errors.partFailed";
}

// A part-level refusal is an integrity violation (class 23); anything else is not the draft's fault.
function isIntegrity(error: unknown): boolean {
  return pgCode(error)?.startsWith("23") ?? false;
}

// One parenthesised row per entry, joined into a single multi-row VALUES.
function rows(entries: SQL[]): SQL {
  return sql.join(
    entries.map((entry) => sql`(${entry})`),
    sql`, `,
  );
}

// Never a bare array parameter (docs/TRAPS.md, "An array binding is not an array").
function weekdaysSql(days: number[] | null): SQL {
  if (days === null) return sql`null::smallint[]`;
  return sql`ARRAY[${sql.join(
    days.map((day) => sql`${day}`),
    sql`, `,
  )}]::smallint[]`;
}

const timeUnits = sql`array[${sql.join(
  TIME_UNITS.map((unit) => sql`${unit}`),
  sql`, `,
)}]::text[]`;

// One statement behind a savepoint (drizzle's nested transaction): its failure rolls back to it and leaves
// the transaction usable. A hand-written `rollback to savepoint` is not enough, the driver then re-raises the
// first error when the transaction ends.
async function attempt(tx: Transaction, run: (inner: Transaction) => Promise<unknown>): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    await tx.transaction(async (inner) => {
      await run(inner as unknown as Transaction);
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

type Update = { g: number; goalId: string; fingerprint: string };

// What the goals of the draft turn into, built inside the transaction once the matches are read.
type Plan = ReturnType<typeof emptyPlan>;

function emptyPlan() {
  return {
    layers: [[], [], []] as SQL[][],
    measureRows: [] as SQL[],
    phaseRows: [] as Part[],
    budgetRows: [] as Part[],
    commitmentRows: [] as Part[],
    parentRows: [] as (Part & { taskId: string })[],
    childRows: [] as (Part & { taskId: string; childId: string })[],
    doneRows: [] as (Part & { taskId: string })[],
    goalIds: [] as string[],
    // The updates of matched goals (RP-130), one list per statement.
    horizonRows: [] as (Part & { g: number })[],
    noteRows: [] as Part[],
    measureUpdates: [] as (Part & { goalId: string })[],
    rhythmRows: [] as Part[],
    monthUpserts: [] as Part[],
    spanRows: [] as (Part & { g: number; endsOn: string })[],
    phaseChecks: new Map<Part, { g: number; endsOn: string }>(),
    retireRows: [] as Part[],
    cadenceRows: [] as Part[],
    taskRows: [] as Part[],
    // The existing parent a new sub-task goes under is kept, whatever the parents' insert keeps.
    existingParents: [] as string[],
    // A matched goal's horizon as it stands, to judge its phases when the new one is refused.
    oldHorizon: new Map<number, string | null>(),
    newHorizon: new Map<number, string | null>(),
    failed: [] as FailedPart[],
  };
}

/**
 * Writes a reviewed import draft (RP-37, RP-88, RP-95): a tree of goals up to three levels deep,
 * with the notes of goals and tasks. The draft is judged again here with the schema and the
 * refusals the reading already passed: the client is not trusted, and a refusal left over is a
 * forged or stale draft. A correction nobody touched arrives accepted; this judges what it gets.
 *
 * One transaction, and a bounded number of statements whatever the draft holds: ids are minted
 * here so parents and children link without a `returning` chain, and each table takes one
 * multi-row insert. The goals take one per layer, at most three: the policy and the trigger of
 * `parent_id` read the table as it stood before the statement, so a parent in the same insert is
 * not yet there (0018). Raw SQL naming the granted columns only (docs/TRAPS.md, "Drizzle's insert
 * builder names every column"); `goals` takes its INSERT grant and its measure columns' UPDATE
 * grant as two statements for the same reason. The same update arms the rhythm (RP-63):
 * `plan_seen` as `setRhythm`'s first rhythm. A goal that holds goals has no rhythm (refused above),
 * so its tasks are written fixed to their month, as `fixHolderTasks` leaves them.
 *
 * RP-130: a draft goal the review sent in `updates` updates the one open goal of its name instead,
 * by the differences the review showed: the snapshot is read again in this transaction and a goal
 * whose differences no longer give the review's fingerprint, or whose name now matches none or two,
 * refuses the whole call before anything is written. Nothing is removed; each kind of update is one
 * statement for every matched goal, so the bound holds. A draft goal that matches one open goal and
 * was not sent is skipped with its parts, never created again; a goal created under it goes under
 * the open goal.
 *
 * RP-90: a phase, month, commitment or task the table still refuses after those checks is returned in `failed`
 * with its name and reason, and the rest is written; only a goal the table refuses fails the call. A matched
 * goal's horizon, measure or rhythm the table or its rules refuse is listed the same way.
 *
 * RP-56: with a `requestId`, a confirm resent after its answer was lost answers the first answer
 * and writes nothing. Two sends of one id wait on each other, so the second reads the first's receipt.
 */
export async function confirmImport(input: unknown): Promise<ConfirmImportResult> {
  const parsed = importUpdateSchema.safeParse(input);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    // A zod default message (an unknown field, a wrong type) is no catalogue key.
    const error = issue.message.includes(".errors.") ? messageKey(issue.message) : "import.errors.draftInvalid";
    // A path in the draft reads as it did when the draft came bare.
    const path = issue.path[0] === "draft" ? issue.path.slice(1) : issue.path;
    return { ok: false, error, at: path.join(".") };
  }
  // RP-37: a phase that starts before the goal opens begins today, one wholly
  // before it is dropped, so the refusals and the rows see the cut draft.
  // A version 2 draft is in minutes already (RP-35).
  const today = todayInZone();
  const draft = withCutPhases(parsed.data.draft, today);
  const updates: Update[] = parsed.data.updates;
  const { requestId } = parsed.data;

  const sent = new Set<number>();
  for (const [u, update] of updates.entries()) {
    if (update.g >= draft.goals.length || sent.has(update.g)) return { ok: false, error: "import.errors.draftInvalid", at: `updates.${u}.g` };
    sent.add(update.g);
  }

  const [refusal] = draftRefusals(draft, today);
  if (refusal) return { ok: false, error: messageKey(refusal.key), at: refusal.path };

  // RP-66: the review drops a figure a goal not measured in time cannot keep; a draft that still carries one is forged.
  const [stray] = strayEstimates(draft).filter((entry) => entry.key === "import.notices.estimateDroppedNotTime");
  if (stray) return { ok: false, error: "import.errors.estimateNotTime", at: stray.path };

  const signedIn = await getPerson();
  if (!signedIn) return { ok: false, error: "import.errors.signedOut" };
  const person = signedIn;

  // RP-47: each table's position is the person's current max plus the row's
  // place in the draft, so the plan's order never rests on how a multi-row
  // VALUES is walked. A VALUES subquery reads the table as it stood before
  // the statement, so every row of one statement sees the same base.
  const basePosition = (table: typeof goals | typeof commitments | typeof oneOffs): SQL =>
    sql`(select coalesce(max(p.position), 0) from ${table} p where p.user_id = ${person.id}::uuid)`;

  function build(matched: Map<number, GoalSnapshot>, skipped: Map<number, GoalSnapshot>): Plan {
    const plan = emptyPlan();
    // The refusals above leave every parent earlier than its child, and none deeper than three.
    const indexOfKey = new Map<string, number>();
    const idOf: string[] = [];
    // A matched goal already stands, so a goal created under it goes in the first layer.
    const layerOf: number[] = [];
    let goalIndex = 0;
    let commitmentIndex = 0;
    // Parents and their children share one sequence in reading order: a child
    // sits at its parent's slot plus its own place under it.
    let taskIndex = 0;

    const commitmentRow = (goalId: string, commitment: DraftGoal["commitments"][number], position: SQL): SQL => sql`
      ${person.id}::uuid, ${goalId}::uuid, ${commitment.name}, ${commitment.cadenceKind},
      ${commitment.cadenceN}::integer, ${weekdaysSql(commitment.cadenceWeekdays)},
      ${commitment.satisfaction}, ${commitment.targetQuantity}::integer, ${commitment.unit}::text, ${position}`;
    const nextCommitment = (): SQL => {
      commitmentIndex += 1;
      return sql`${basePosition(commitments)} + ${commitmentIndex}::integer`;
    };

    // A new task with its sub-tasks, as an import writes one: `in_plan` is named, since the trigger sets it
    // only for a row with a month or a parent.
    const addTask = (goalId: string, task: DraftGoal["tasks"][number], at: string, timed: boolean) => {
      const taskId = randomUUID();
      taskIndex += 1;
      const plannedMonth = !timed ? sql`${monthStart(task.month)}::date` : sql`null::date`;
      plan.parentRows.push({
        taskId,
        row: sql`${taskId}::uuid, ${person.id}::uuid, ${goalId}::uuid, ${task.name}, ${plannedMonth}, ${timed}::boolean, ${task.estimate}::integer, ${task.note ?? null}::text, ${basePosition(oneOffs)} + ${taskIndex}::integer`,
        path: at,
        name: task.name,
      });
      // RP-96: a task the plan marked done is born done, on the day it names.
      if (task.doneOn) {
        plan.doneRows.push({ taskId, row: sql`${person.id}::uuid, ${taskId}::uuid, ${goalId}::uuid, ${task.doneOn}::date`, path: at, name: task.name });
      }
      for (const [place, child] of task.children.entries()) {
        taskIndex += 1;
        // The parent's own row already holds base + its index.
        addChild(goalId, taskId, child, `${at}.children.${place}`, sql`(select p.position from ${oneOffs} p where p.id = ${taskId}::uuid) + ${place + 1}::integer`);
      }
    };
    const addChild = (goalId: string, taskId: string, child: DraftGoal["tasks"][number]["children"][number], at: string, position: SQL) => {
      const childId = randomUUID();
      plan.childRows.push({
        taskId,
        childId,
        row: sql`${childId}::uuid, ${person.id}::uuid, ${goalId}::uuid, ${taskId}::uuid, ${child.name}, ${child.estimate}::integer, ${child.note ?? null}::text, ${position}`,
        path: at,
        name: child.name,
      });
      if (child.doneOn) {
        plan.doneRows.push({ taskId: childId, row: sql`${person.id}::uuid, ${childId}::uuid, ${goalId}::uuid, ${child.doneOn}::date`, path: at, name: child.name });
      }
    };
    // RP-67: with a rhythm the month only orders the tasks; Array.sort is stable, so a month keeps reading order.
    const inOrder = <T extends { month: string }>(tasks: T[], timed: boolean) =>
      !timed ? tasks.map((task, t) => ({ task, t })) : tasks.map((task, t) => ({ task, t })).sort((a, b) => a.task.month.localeCompare(b.task.month));

    for (const [g, goal] of draft.goals.entries()) {
      const at = `goals.${g}`;
      const parentAt = goal.parent === null ? undefined : indexOfKey.get(goal.parent);
      if (!indexOfKey.has(goal.key)) indexOfKey.set(goal.key, g);
      const snapshot = matched.get(g) ?? skipped.get(g);
      if (snapshot) {
        idOf.push(snapshot.id);
        layerOf.push(-1);
        if (matched.has(g)) addUpdate(g, goal, snapshot);
        continue;
      }

      const goalId = randomUUID();
      const parentId = parentAt === undefined ? null : idOf[parentAt];
      const layer = parentAt === undefined ? 0 : layerOf[parentAt] + 1;
      idOf.push(goalId);
      layerOf.push(layer);
      plan.goalIds.push(goalId);
      goalIndex += 1;
      plan.layers[layer].push(
        sql`${goalId}::uuid, ${person.id}::uuid, ${goal.name}, ${goal.horizon}::date, ${parentId}::uuid, ${goal.note}::text, ${basePosition(goals)} + ${goalIndex}::integer`,
      );
      if (goal.measure !== null) {
        plan.measureRows.push(sql`${goalId}::uuid, ${goal.measure.name}, ${goal.measure.unit}, ${goal.rhythm}::integer, ${isTimeUnit(goal.measure.unit)}::boolean`);
      }
      goal.phases.forEach((phase, p) => {
        plan.phaseRows.push({
          row: sql`${person.id}::uuid, ${goalId}::uuid, ${phase.aim}, ${phase.startsOn}::date, ${phase.endsOn}::date`,
          path: `${at}.phases.${p}`,
          name: phase.aim,
        });
      });
      goal.months.forEach((entry, m) => {
        plan.budgetRows.push({
          row: sql`${person.id}::uuid, ${goalId}::uuid, ${monthStart(entry.month)}::date, ${entry.amount}::integer`,
          path: `${at}.months.${m}`,
          name: entry.month,
        });
      });
      goal.commitments.forEach((commitment, c) => {
        plan.commitmentRows.push({ row: commitmentRow(goalId, commitment, nextCommitment()), path: `${at}.commitments.${c}`, name: commitment.name });
      });
      const timed = goal.rhythm !== null && goal.measure !== null && isTimeUnit(goal.measure.unit);
      for (const { task, t } of inOrder(goal.tasks, timed)) addTask(goalId, task, `${at}.tasks.${t}`, timed);
    }

    // The parts of `goal` that differ from `snapshot`, as `differences` lists them, and nothing it omits.
    function addUpdate(g: number, goal: DraftGoal, snapshot: GoalSnapshot) {
      const at = `goals.${g}`;
      const id = snapshot.id;
      const listed = differences(goal, snapshot, today);
      const find = <K extends Difference["kind"]>(kind: K) => listed.find((d): d is Extract<Difference, { kind: K }> => d.kind === kind);

      const horizon = find("horizon");
      if (horizon) {
        // RP-25: no phase may outlast the goal, its phases counted as this import leaves them.
        const ends = snapshot.phases.map((have) => goal.phases.find((p) => nameKey(p.aim) === nameKey(have.aim))?.endsOn ?? have.endsOn);
        if (ends.some((endsOn) => endsOn >= horizon.to)) {
          plan.failed.push({ path: `${at}.horizon`, name: horizon.to, reason: "goal.errors.horizonBeforePhase" });
        } else {
          plan.horizonRows.push({ g, row: sql`${id}::uuid, ${horizon.to}::date`, path: `${at}.horizon`, name: horizon.to });
        }
      }
      plan.oldHorizon.set(g, snapshot.horizon);
      plan.newHorizon.set(g, horizon?.to ?? snapshot.horizon);

      const note = find("note");
      if (note) plan.noteRows.push({ row: sql`${id}::uuid, ${note.to}::text`, path: `${at}.note`, name: goal.name });

      // A measure a fact feeds stays (RP-134); the statement's own gate lists any the read missed.
      const measure = find("measure");
      const measureLands = measure !== undefined && measure.kept === null;
      if (measure?.kept === "fed") plan.failed.push({ path: `${at}.measure`, name: measure.name, reason: "plan.errors.measureFed" });
      if (measure && measureLands) {
        plan.measureUpdates.push({ goalId: id, row: sql`${id}::uuid, ${measure.name}::text, ${measure.unit}::text`, path: `${at}.measure`, name: measure.name });
      }

      const rhythm = find("rhythm");
      if (rhythm) plan.rhythmRows.push({ row: sql`${id}::uuid, ${rhythm.to}::integer`, path: `${at}.rhythm`, name: goal.name });

      // Whether the goal places its tasks after this import (RP-67), as the measure and rhythm statements leave it.
      const unit = measureLands ? measure.unit : (snapshot.measure?.unit ?? null);
      const unitKept = !measureLands || snapshot.measure?.unit === measure.unit;
      const rhythmAfter = rhythm ? rhythm.to : unitKept ? snapshot.rhythm : null;
      const timed = rhythmAfter !== null && isTimeUnit(unit);

      // The last of a month listed twice is the one the plan means.
      const months = new Map<string, Part>();
      for (const entry of listed) {
        if (entry.kind !== "month") continue;
        const m = goal.months.findLastIndex((have) => have.month.slice(0, 7) === entry.month);
        months.set(entry.month, {
          row: sql`${person.id}::uuid, ${id}::uuid, ${monthStart(entry.month)}::date, ${entry.amount}::integer`,
          path: `${at}.months.${m}`,
          name: entry.month,
        });
      }
      plan.monthUpserts.push(...months.values());

      goal.phases.forEach((phase, p) => {
        const have = snapshot.phases.find((s) => nameKey(s.aim) === nameKey(phase.aim));
        const path = `${at}.phases.${p}`;
        // A phase that crosses another is left out even when the review sent it marked.
        if (listed.some((d) => d.kind === "phaseOverlaps" && nameKey(d.aim) === nameKey(phase.aim))) {
          plan.failed.push({ path, name: phase.aim, reason: "import.errors.phaseOverlaps" });
          return;
        }
        if (!have) {
          const part = { row: sql`${person.id}::uuid, ${id}::uuid, ${phase.aim}, ${phase.startsOn}::date, ${phase.endsOn}::date`, path, name: phase.aim };
          plan.phaseRows.push(part);
          plan.phaseChecks.set(part, { g, endsOn: phase.endsOn });
        } else if (have.startsOn !== phase.startsOn || have.endsOn !== phase.endsOn) {
          plan.spanRows.push({ g, endsOn: phase.endsOn, row: sql`${have.id}::uuid, ${phase.startsOn}::date, ${phase.endsOn}::date`, path, name: phase.aim });
        }
      });

      // RP-127: a cadence a fact was declared against stays on its commitment, retired; the plan's opens beside it.
      goal.commitments.forEach((commitment, c) => {
        const have = snapshot.commitments.find((s) => nameKey(s.name) === nameKey(commitment.name));
        const path = `${at}.commitments.${c}`;
        if (!have) {
          plan.commitmentRows.push({ row: commitmentRow(id, commitment, nextCommitment()), path, name: commitment.name });
          return;
        }
        const kinds = listed.filter((d) => (d.kind === "commitmentChanged" || d.kind === "commitmentReplaced") && nameKey(d.name) === nameKey(commitment.name));
        if (kinds.length === 0) return;
        if (!have.hasFacts) {
          plan.cadenceRows.push({
            row: sql`${have.id}::uuid, ${commitment.cadenceKind}::text, ${commitment.cadenceN}::integer, ${weekdaysSql(commitment.cadenceWeekdays)}`,
            path,
            name: commitment.name,
          });
          return;
        }
        plan.retireRows.push({ row: sql`${have.id}::uuid`, path, name: commitment.name });
        // The new one takes the old one's place in the list.
        plan.commitmentRows.push({
          row: commitmentRow(id, commitment, sql`(select p.position from ${commitments} p where p.id = ${have.id}::uuid)`),
          path,
          name: commitment.name,
        });
      });

      for (const { task, t } of inOrder(goal.tasks, timed)) {
        const path = `${at}.tasks.${t}`;
        const have = snapshot.tasks.find((s) => nameKey(s.name) === nameKey(task.name));
        if (!have) {
          addTask(id, task, path, timed);
          continue;
        }
        if (have.done) continue;
        if (have.estimate !== task.estimate || have.month.slice(0, 7) !== task.month.slice(0, 7)) {
          // A task the plan places keeps no fixed month.
          const month = timed ? sql`null::date` : sql`${monthStart(task.month)}::date`;
          plan.taskRows.push({ row: sql`${have.id}::uuid, ${task.estimate}::integer, ${month}, ${timed}::boolean`, path, name: task.name });
        }
        let added = 0;
        for (const [place, child] of task.children.entries()) {
          if (have.children.some((s) => nameKey(s.name) === nameKey(child.name))) continue;
          added += 1;
          if (added === 1) plan.existingParents.push(have.id);
          // After the parent's last sub-task, in the plan's order.
          addChild(
            id,
            have.id,
            child,
            `${path}.children.${place}`,
            sql`(select max(p.position) from ${oneOffs} p where p.id = ${have.id}::uuid or p.parent_id = ${have.id}::uuid) + ${added}::integer`,
          );
        }
      }
    }

    return plan;
  }

  // The fast path writes each table in one statement, as always. When the table refuses a part, that
  // transaction is gone: the same rows are written again with each table behind a savepoint, and a
  // table that refuses falls back to one savepoint per part, so only the refused part is left out (RP-90).
  const write = (tolerant: boolean) =>
    withGoalsDb(async (tx): Promise<{ stale: string } | { replay: ConfirmImportResult } | { plan: Plan; updatedIds: string[] }> => {
      if (requestId !== undefined) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestId}::text || ':request', 0))`);
        const stored = await readReceipt(tx, person.id, requestId);
        if (stored !== null) return { replay: stored as ConfirmImportResult };
      }
      // RP-130: the review's matches are judged against the goals as they stand in this transaction.
      const matched = new Map<number, GoalSnapshot>();
      const matches = matchGoals(draft, await loadImportSnapshots(draft.goals.map((goal) => goal.name), tx));
      for (const update of updates) {
        const found = matches[update.g].match;
        const stale =
          found === null ||
          found === "ambiguous" ||
          found.id !== update.goalId ||
          fingerprint(differences(draft.goals[update.g], found, today)) !== update.fingerprint;
        if (stale) return { stale: `goals.${update.g}` };
        matched.set(update.g, found);
      }
      // A goal that matches one open goal and was not confirmed is left alone: never created again, never changed.
      // Two open goals of the name are no match, so that goal is created as before.
      const skipped = new Map<number, GoalSnapshot>();
      for (const { g, match } of matches) {
        if (match !== null && match !== "ambiguous" && !matched.has(g)) skipped.set(g, match);
      }

      const plan = build(matched, skipped);
      const { failed } = plan;
      const put = async <P extends Part>(parts: P[], statement: (values: SQL) => SQL): Promise<P[]> => {
        if (parts.length === 0) return [];
        if (!tolerant) {
          await tx.execute(statement(rows(parts.map((part) => part.row))));
          return parts;
        }
        const landed = await attempt(tx, (inner) => inner.execute(statement(rows(parts.map((part) => part.row)))));
        if (landed.ok) return parts;
        const kept: P[] = [];
        for (const part of parts) {
          const one = await attempt(tx, (inner) => inner.execute(statement(rows([part.row]))));
          if (one.ok) kept.push(part);
          else failed.push({ path: part.path, name: part.name, reason: reasonOf(one.error) });
        }
        return kept;
      };

      // The matched goals first: a goal created under one is judged against its new horizon (RP-79).
      const movedHorizon = new Set(
        (await put(plan.horizonRows, (values) => sql`
          update ${goals} set horizon = v.horizon from (values ${values}) as v(id, horizon) where ${goals}.id = v.id
        `)).map((part) => part.g),
      );
      await put(plan.noteRows, (values) => sql`
        update ${goals} set note = v.note from (values ${values}) as v(id, note) where ${goals}.id = v.id
      `);
      // `changeGoalMeasure`'s rule: a new name keeps the rhythm and the amounts, a new unit clears both.
      if (plan.measureUpdates.length > 0) {
        const gate = await tx.execute<{ id: string; fed: boolean; holder: boolean }>(sql`
          with v(id, name, unit) as (values ${rows(plan.measureUpdates.map((part) => part.row))}),
          t as (
            select g.id, g.measure_unit,
                   ${measureFed(sql`g.id`)} as fed,
                   exists (select 1 from ${goals} c where c.parent_id = g.id and c.archived_at is null) as holder
            from ${goals} g where g.id in (select id from v)
          ),
          eligible as (
            select t.id, t.measure_unit as old_unit, v.name, v.unit from t join v on v.id = t.id where not t.fed and not t.holder
          ),
          upd as (
            update ${goals} set measure_name = e.name, measure_unit = e.unit,
              rhythm = case when ${goals}.measure_unit = e.unit then ${goals}.rhythm else null end
            from eligible e where ${goals}.id = e.id returning ${goals}.id
          ),
          del as (
            delete from ${monthBudgets}
            where goal_id in (select id from eligible where old_unit is distinct from unit) returning 1
          )
          select id::text as id, fed, holder from t
        `);
        const refused = new Map(gate.filter((row) => row.fed || row.holder).map((row) => [row.id, row]));
        for (const part of plan.measureUpdates) {
          const row = refused.get(part.goalId);
          if (row) failed.push({ path: part.path, name: part.name, reason: row.fed ? "plan.errors.measureFed" : "plan.errors.holderNoMeasure" });
        }
      }
      // `setRhythm`'s rule (RP-76, RP-63, RP-67): the closed months keep the plan they were lived against, a first
      // rhythm on a time goal arms `plan_seen` and lets the plan place the tasks no fact pins.
      await put(plan.rhythmRows, (values) => sql`
        with v(id, rhythm) as (values ${values}),
        ok as (
          select g.id, g.rhythm as old, v.rhythm as new, lower(trim(g.measure_unit)) = any(${timeUnits}) as timed
          from ${goals} g join v on v.id = g.id where g.measure_unit is not null
        ),
        ins as (${freezeClosedMonths(sql`(select ok.id from ok where ok.id = g.id)`, sql`(select ok.old from ok where ok.id = g.id)`, today)}),
        upd as (
          update ${goals} set rhythm = ok.new,
            plan_seen = case when ok.old is null and ok.timed
              then greatest(${goals}.plan_seen, (date_trunc('month', ${today}::date) - interval '1 month')::date)
              else ${goals}.plan_seen end
          from ok where ${goals}.id = ok.id returning ${goals}.id
        ),
        rel as (
          update ${oneOffs} set planned_month = null
          where goal_id in (select id from ok where old is null and timed)
            and parent_id is null and planned_month is not null
            and not exists (select 1 from ${facts} f where f.one_off_id = ${oneOffs}.id)
            and not (
              exists (select 1 from ${oneOffs} c where c.parent_id = ${oneOffs}.id)
              and not exists (
                select 1 from ${oneOffs} c where c.parent_id = ${oneOffs}.id
                  and not exists (select 1 from ${facts} f where f.one_off_id = c.id)
              )
            )
          returning 1
        )
        select 1
      `);
      await put(plan.monthUpserts, (values) => sql`
        insert into ${monthBudgets} (user_id, goal_id, month, amount) values ${values}
        on conflict (goal_id, month) do update set amount = excluded.amount
      `);

      // One statement per layer, parents first.
      for (const layer of plan.layers) {
        if (layer.length === 0) continue;
        await tx.execute(sql`
          insert into ${goals} (id, user_id, name, horizon, parent_id, note, position) values ${rows(layer)}
        `);
      }
      if (plan.measureRows.length > 0) {
        await tx.execute(sql`
          update ${goals} set measure_name = m.name, measure_unit = m.unit, rhythm = m.rhythm,
            plan_seen = case when m.rhythm is null or not m.timed then plan_seen
              else (date_trunc('month', ${today}::date) - interval '1 month')::date end
          from (values ${rows(plan.measureRows)}) as m(id, name, unit, rhythm, timed)
          where ${goals}.id = m.id
        `);
      }

      // A matched goal's phase stays inside the horizon it keeps: the new one, or the old one when refused.
      const fits = (g: number, endsOn: string): boolean => {
        const horizon = movedHorizon.has(g) ? plan.newHorizon.get(g) : plan.oldHorizon.get(g);
        return horizon === null || horizon === undefined || endsOn < horizon;
      };
      const inside = <P extends Part>(parts: P[], check: (part: P) => { g: number; endsOn: string } | undefined): P[] =>
        parts.filter((part) => {
          const span = check(part);
          if (!span || fits(span.g, span.endsOn)) return true;
          failed.push({ path: part.path, name: part.name, reason: "plan.errors.phasePastHorizon" });
          return false;
        });
      await put(inside(plan.phaseRows, (part) => plan.phaseChecks.get(part)), (values) => sql`
        insert into ${phases} (user_id, goal_id, aim, starts_on, ends_on) values ${values}
      `);
      await put(inside(plan.spanRows, (part) => part), (values) => sql`
        update ${phases} set starts_on = v.starts_on, ends_on = v.ends_on
        from (values ${values}) as v(id, starts_on, ends_on) where ${phases}.id = v.id
      `);
      await put(plan.budgetRows, (values) => sql`
        insert into ${monthBudgets} (user_id, goal_id, month, amount) values ${values}
      `);
      await put(plan.retireRows, (values) => sql`
        update ${commitments} set retired_at = now() where id in (select v.id from (values ${values}) as v(id))
      `);
      await put(plan.cadenceRows, (values) => sql`
        update ${commitments} set cadence_kind = v.kind, cadence_n = v.n, cadence_weekdays = v.weekdays
        from (values ${values}) as v(id, kind, n, weekdays) where ${commitments}.id = v.id
      `);
      await put(plan.commitmentRows, (values) => sql`
        insert into ${commitments}
          (user_id, goal_id, name, cadence_kind, cadence_n, cadence_weekdays,
           satisfaction, target_quantity, unit, position)
        values ${values}
      `);
      await put(plan.taskRows, (values) => sql`
        update ${oneOffs} set estimate = v.estimate,
          planned_month = case when v.timed then ${oneOffs}.planned_month else v.month end
        from (values ${values}) as v(id, estimate, month, timed) where ${oneOffs}.id = v.id
      `);
      // Parents before children: the child's policy reads its parent back.
      const keptParents = await put(plan.parentRows, (values) => sql`
        insert into ${oneOffs} (id, user_id, goal_id, name, planned_month, in_plan, estimate, note, position)
        values ${values}
      `);
      const keptIds = new Set([...keptParents.map((part) => part.taskId), ...plan.existingParents]);
      // A refused parent takes its sub-tasks with it, and they are not listed apart.
      const keptChildren = await put(
        plan.childRows.filter((part) => keptIds.has(part.taskId)),
        (values) => sql`
          insert into ${oneOffs} (id, user_id, goal_id, parent_id, name, estimate, note, position)
          values ${values}
        `,
      );
      // RP-96: a task or sub-task the plan marked done is born done, on the day it names.
      const keptDone = new Set([...keptParents.map((part) => part.taskId), ...keptChildren.map((part) => part.childId)]);
      await put(
        plan.doneRows.filter((part) => keptDone.has(part.taskId)),
        (values) => sql`
          insert into ${facts} (user_id, one_off_id, goal_id, day) values ${values}
        `,
      );
      const updatedIds = [...matched.values()].map((snapshot) => snapshot.id);
      if (requestId !== undefined) {
        const answer: ConfirmImportResult = { ok: true, goalIds: plan.goalIds, updatedIds, failed: plan.failed };
        await writeReceipt(tx, person.id, requestId, "confirmImport", answer);
      }
      return { plan, updatedIds };
    });

  let written: Awaited<ReturnType<typeof write>>;
  try {
    written = await write(false);
  } catch (error) {
    if (!isIntegrity(error)) throw error;
    written = await write(true);
  }
  if ("replay" in written) return written.replay;
  if ("stale" in written) return { ok: false, error: "import.errors.reviewStale", at: written.stale };

  const { plan, updatedIds } = written;
  for (const id of updatedIds) revalidatePath(`/metas/${id}`, "layout");
  revalidatePath("/");
  revalidatePath("/metas");
  return { ok: true, goalIds: plan.goalIds, updatedIds, failed: plan.failed };
}
