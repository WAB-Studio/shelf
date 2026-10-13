"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { sql, type SQL } from "drizzle-orm";

import { commitments, facts, goals, monthBudgets, oneOffs, phases } from "@/db/schema";
import { pgCode } from "@/lib/db-error";
import { draftRefusals, draftV2Schema, strayEstimates, withCutPhases } from "@/lib/import/draft";
import { getPerson, withGoalsDb, type Transaction } from "@/lib/session";
import { isTimeUnit } from "@/lib/units/time";
import { monthStart } from "@/lib/validation/budget";
import { todayInZone } from "@/lib/zone";
import { messageKey, type MessageKey } from "@/i18n/translator";

// A part the table refused after everything the review checks: its path in the draft, its name, and why.
export type FailedPart = { path: string; name: string; reason: MessageKey };

export type ConfirmImportResult =
  | { ok: true; goalIds: string[]; failed: FailedPart[] }
  | { ok: false; error: MessageKey; at?: string };

// A row of one multi-row insert, kept with what names it if the table refuses it.
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
 * RP-90: a phase, month, commitment or task the table still refuses after those checks is returned in `failed`
 * with its name and reason, and the rest is written; only a goal the table refuses fails the call.
 */
export async function confirmImport(input: unknown): Promise<ConfirmImportResult> {
  const parsed = draftV2Schema.safeParse(input);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    // A zod default message (an unknown field, a wrong type) is no catalogue key.
    const error = issue.message.includes(".errors.") ? messageKey(issue.message) : "import.errors.draftInvalid";
    return { ok: false, error, at: issue.path.join(".") };
  }
  // RP-37: a phase that starts before the goal opens begins today, one wholly
  // before it is dropped, so the refusals and the rows see the cut draft.
  // A version 2 draft is in minutes already (RP-65).
  const today = todayInZone();
  const draft = withCutPhases(parsed.data, today);

  const [refusal] = draftRefusals(draft, today);
  if (refusal) return { ok: false, error: messageKey(refusal.key), at: refusal.path };

  // RP-66: the review drops a figure a goal not measured in time cannot keep; a draft that still carries one is forged.
  const [stray] = strayEstimates(draft).filter((entry) => entry.key === "import.notices.estimateDroppedNotTime");
  if (stray) return { ok: false, error: "import.errors.estimateNotTime", at: stray.path };

  // RP-63: a rhythm is minutes, so it needs a time measure; a forged draft can carry one without.
  const untimed = draft.goals.findIndex((goal) => goal.rhythm !== null && (goal.measure === null || !isTimeUnit(goal.measure.unit)));
  if (untimed >= 0) return { ok: false, error: "roadmap.errors.rhythmNotTime", at: `goals.${untimed}.rhythm` };

  const person = await getPerson();
  if (!person) return { ok: false, error: "import.errors.signedOut" };

  // The refusals above leave every parent earlier than its child, and none deeper than three.
  const indexOfKey = new Map<string, number>();
  const layerOf: number[] = [];
  const layers: SQL[][] = [[], [], []];
  const measureRows: SQL[] = [];
  const phaseRows: Part[] = [];
  const budgetRows: Part[] = [];
  const commitmentRows: Part[] = [];
  const parentRows: (Part & { taskId: string })[] = [];
  const childRows: (Part & { taskId: string; childId: string })[] = [];
  const doneRows: (Part & { taskId: string })[] = [];
  const goalIds: string[] = [];

  // RP-47: each table's position is the person's current max plus the row's
  // place in the draft, so the plan's order never rests on how a multi-row
  // VALUES is walked. A VALUES subquery reads the table as it stood before
  // the statement, so every row of one statement sees the same base.
  const basePosition = (table: typeof goals | typeof commitments | typeof oneOffs): SQL =>
    sql`(select coalesce(max(p.position), 0) from ${table} p where p.user_id = ${person.id}::uuid)`;
  let goalIndex = 0;
  let commitmentIndex = 0;
  // Parents and their children share one sequence in reading order: a child
  // sits at its parent's slot plus its own place under it.
  let taskIndex = 0;

  for (const goal of draft.goals) {
    const goalId = randomUUID();
    const parentAt = goal.parent === null ? undefined : indexOfKey.get(goal.parent);
    const parentId = parentAt === undefined ? null : goalIds[parentAt];
    const layer = parentAt === undefined ? 0 : layerOf[parentAt] + 1;
    if (!indexOfKey.has(goal.key)) indexOfKey.set(goal.key, goalIds.length);
    goalIds.push(goalId);
    layerOf.push(layer);
    goalIndex += 1;
    layers[layer].push(
      sql`${goalId}::uuid, ${person.id}::uuid, ${goal.name}, ${goal.horizon}::date, ${parentId}::uuid, ${goal.note}::text, ${basePosition(goals)} + ${goalIndex}::integer`,
    );
    if (goal.measure !== null) {
      measureRows.push(sql`${goalId}::uuid, ${goal.measure.name}, ${goal.measure.unit}, ${goal.rhythm}::integer`);
    }
    const at = `goals.${goalIds.length - 1}`;
    goal.phases.forEach((phase, p) => {
      phaseRows.push({
        row: sql`${person.id}::uuid, ${goalId}::uuid, ${phase.aim}, ${phase.startsOn}::date, ${phase.endsOn}::date`,
        path: `${at}.phases.${p}`,
        name: phase.aim,
      });
    });
    goal.months.forEach((entry, m) => {
      budgetRows.push({
        row: sql`${person.id}::uuid, ${goalId}::uuid, ${monthStart(entry.month)}::date, ${entry.amount}::integer`,
        path: `${at}.months.${m}`,
        name: entry.month,
      });
    });
    goal.commitments.forEach((commitment, c) => {
      commitmentIndex += 1;
      commitmentRows.push({
        row: sql`
        ${person.id}::uuid, ${goalId}::uuid, ${commitment.name}, ${commitment.cadenceKind},
        ${commitment.cadenceN}::integer, ${weekdaysSql(commitment.cadenceWeekdays)},
        ${commitment.satisfaction}, ${commitment.targetQuantity}::integer, ${commitment.unit}::text,
        ${basePosition(commitments)} + ${commitmentIndex}::integer`,
        path: `${at}.commitments.${c}`,
        name: commitment.name,
      });
    });
    // RP-67: with a rhythm the month only orders the tasks; Array.sort is stable, so a month keeps reading order.
    const ordered = goal.rhythm === null ? goal.tasks.map((task, t) => ({ task, t })) : goal.tasks.map((task, t) => ({ task, t })).sort((a, b) => a.task.month.localeCompare(b.task.month));
    for (const { task, t } of ordered) {
      const taskId = randomUUID();
      taskIndex += 1;
      const parentIndex = taskIndex;
      // `in_plan` is named: the trigger sets it only for a row with a month or a parent.
      const plannedMonth = goal.rhythm === null ? sql`${monthStart(task.month)}::date` : sql`null::date`;
      parentRows.push({
        taskId,
        row: sql`${taskId}::uuid, ${person.id}::uuid, ${goalId}::uuid, ${task.name}, ${plannedMonth}, ${goal.rhythm !== null}::boolean, ${task.estimate}::integer, ${task.note ?? null}::text, ${basePosition(oneOffs)} + ${parentIndex}::integer`,
        path: `${at}.tasks.${t}`,
        name: task.name,
      });
      // RP-96: a task the plan marked done is born done, on the day it names.
      if (task.doneOn) {
        doneRows.push({
          taskId,
          row: sql`${person.id}::uuid, ${taskId}::uuid, ${goalId}::uuid, ${task.doneOn}::date`,
          path: `${at}.tasks.${t}`,
          name: task.name,
        });
      }
      for (const [place, child] of task.children.entries()) {
        taskIndex += 1;
        const childId = randomUUID();
        // The parent's own row already holds base + parentIndex.
        childRows.push({
          taskId,
          childId,
          row: sql`${childId}::uuid, ${person.id}::uuid, ${goalId}::uuid, ${taskId}::uuid, ${child.name}, ${child.estimate}::integer, ${child.note ?? null}::text, (select p.position from ${oneOffs} p where p.id = ${taskId}::uuid) + ${place + 1}::integer`,
          path: `${at}.tasks.${t}.children.${place}`,
          name: child.name,
        });
        if (child.doneOn) {
          doneRows.push({
            taskId: childId,
            row: sql`${person.id}::uuid, ${childId}::uuid, ${goalId}::uuid, ${child.doneOn}::date`,
            path: `${at}.tasks.${t}.children.${place}`,
            name: child.name,
          });
        }
      }
    }
  }

  // The fast path writes each table in one statement, as always. When the table refuses a part, that
  // transaction is gone: the same rows are written again with each table behind a savepoint, and a
  // table that refuses falls back to one savepoint per part, so only the refused part is left out (RP-90).
  const write = (tolerant: boolean) =>
    withGoalsDb(async (tx) => {
      const failed: FailedPart[] = [];
      // One statement per layer, parents first.
      for (const layer of layers) {
        if (layer.length === 0) continue;
        await tx.execute(sql`
          insert into ${goals} (id, user_id, name, horizon, parent_id, note, position) values ${rows(layer)}
        `);
      }
      if (measureRows.length > 0) {
        await tx.execute(sql`
          update ${goals} set measure_name = m.name, measure_unit = m.unit, rhythm = m.rhythm,
            plan_seen = case when m.rhythm is null then plan_seen
              else (date_trunc('month', ${today}::date) - interval '1 month')::date end
          from (values ${rows(measureRows)}) as m(id, name, unit, rhythm)
          where ${goals}.id = m.id
        `);
      }
      const put = async <P extends Part>(parts: P[], insert: (values: SQL) => SQL): Promise<P[]> => {
        if (parts.length === 0) return [];
        if (!tolerant) {
          await tx.execute(insert(rows(parts.map((part) => part.row))));
          return parts;
        }
        const landed = await attempt(tx, (inner) => inner.execute(insert(rows(parts.map((part) => part.row)))));
        if (landed.ok) return parts;
        const kept: P[] = [];
        for (const part of parts) {
          const one = await attempt(tx, (inner) => inner.execute(insert(rows([part.row]))));
          if (one.ok) kept.push(part);
          else failed.push({ path: part.path, name: part.name, reason: reasonOf(one.error) });
        }
        return kept;
      };
      await put(phaseRows, (values) => sql`
        insert into ${phases} (user_id, goal_id, aim, starts_on, ends_on) values ${values}
      `);
      await put(budgetRows, (values) => sql`
        insert into ${monthBudgets} (user_id, goal_id, month, amount) values ${values}
      `);
      await put(commitmentRows, (values) => sql`
        insert into ${commitments}
          (user_id, goal_id, name, cadence_kind, cadence_n, cadence_weekdays,
           satisfaction, target_quantity, unit, position)
        values ${values}
      `);
      // Parents before children: the child's policy reads its parent back.
      const keptParents = await put(parentRows, (values) => sql`
        insert into ${oneOffs} (id, user_id, goal_id, name, planned_month, in_plan, estimate, note, position)
        values ${values}
      `);
      const keptIds = new Set(keptParents.map((part) => part.taskId));
      // A refused parent takes its sub-tasks with it, and they are not listed apart.
      const keptChildren = await put(
        childRows.filter((part) => keptIds.has(part.taskId)),
        (values) => sql`
          insert into ${oneOffs} (id, user_id, goal_id, parent_id, name, estimate, note, position)
          values ${values}
        `,
      );
      // RP-96: a task or sub-task the plan marked done is born done, on the day it names.
      const keptDone = new Set([...keptIds, ...keptChildren.map((part) => part.childId)]);
      await put(
        doneRows.filter((part) => keptDone.has(part.taskId)),
        (values) => sql`
          insert into ${facts} (user_id, one_off_id, goal_id, day) values ${values}
        `,
      );
      return failed;
    });

  let failed: FailedPart[];
  try {
    failed = await write(false);
  } catch (error) {
    if (!isIntegrity(error)) throw error;
    failed = await write(true);
  }

  revalidatePath("/");
  revalidatePath("/metas");
  return { ok: true, goalIds, failed };
}
