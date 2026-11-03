"use server";

import { revalidatePath } from "next/cache";

import { and, eq, inArray, sql } from "drizzle-orm";

import { goals, timeAllocations, timeEntries } from "@/db/schema";
import { messageKey, type MessageKey } from "@/i18n/translator";
import { NamedError } from "@/lib/actions/named-error";
import { getPerson, withGoalsDb, type Transaction } from "@/lib/session";
import { isTimeUnit } from "@/lib/units/time";
import { earliestPastDay } from "@/lib/validation/fact";
import {
  confirmTimeEntrySchema,
  recordTimeEntrySchema,
  settlement,
  timeEntryIdSchema,
  type ConfirmTimeEntryInput,
  type RecordTimeEntryInput,
  type TimeEntryIdInput,
} from "@/lib/validation/time-entry";
import { todayInZone } from "@/lib/zone";

export type TimeEntryResult = { ok: true } | { ok: false; error: MessageKey };

// An entry is settled one transaction at a time: two devices confirming or dismissing it queue here.
const entryLock = (tx: Transaction, entryId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${entryId}::text || ':time', 0))`);

function refresh() {
  revalidatePath("/");
  revalidatePath("/metas", "layout");
  revalidatePath("/mes");
  revalidatePath("/dia", "layout");
}

// The entry under its lock, with whether anything was already placed from it.
async function readEntry(tx: Transaction, entryId: string) {
  await entryLock(tx, entryId);
  const [entry] = await tx
    .select({
      minutes: timeEntries.minutes,
      dismissedAt: timeEntries.dismissedAt,
      allocated: sql<boolean>`exists (select 1 from ${timeAllocations} a where a.entry_id = ${timeEntries}.id)`,
    })
    .from(timeEntries)
    .where(eq(timeEntries.id, entryId));
  if (!entry) throw new NamedError("day.errors.notFound");
  return entry;
}

async function settle(run: () => Promise<void>): Promise<TimeEntryResult> {
  try {
    await run();
  } catch (error) {
    if (error instanceof NamedError) return { ok: false, error: messageKey(error.message) };
    throw error;
  }
  refresh();
  return { ok: true };
}

/**
 * Gives a waiting entry's minutes to goals measured in time (RP-151): one allocation confirms it for that goal,
 * several split it, and together they add up to the entry. Only this adds time to a goal's measure.
 */
export async function confirmTimeEntry(input: ConfirmTimeEntryInput): Promise<TimeEntryResult> {
  const parsed = confirmTimeEntrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "day.errors.signedOut" };

  const { entryId, allocations } = parsed.data;

  return settle(() =>
    withGoalsDb(async (tx) => {
      const entry = await readEntry(tx, entryId);
      if (entry.dismissedAt !== null || entry.allocated) throw new NamedError("day.errors.timeEntryHandled");
      if (settlement(entry.minutes, allocations) !== "exact") throw new NamedError("day.errors.timeAllocationSum");

      // Read back under RLS: a goal that is not the caller's reads as missing.
      const named = await tx
        .select({ id: goals.id, unit: goals.measureUnit })
        .from(goals)
        .where(
          inArray(
            goals.id,
            allocations.map((line) => line.goalId),
          ),
        );
      if (named.length !== allocations.length) throw new NamedError("day.errors.notFound");
      if (named.some((goal) => !isTimeUnit(goal.unit))) throw new NamedError("day.errors.timeNotMeasured");

      await tx.insert(timeAllocations).values(
        allocations.map((line) => ({ userId: person.id, entryId, goalId: line.goalId, minutes: line.minutes })),
      );
    }),
  );
}

/** «No cuenta» (RP-151): the entry adds to no goal and leaves the tray. */
export async function dismissTimeEntry(input: TimeEntryIdInput): Promise<TimeEntryResult> {
  const parsed = timeEntryIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "day.errors.signedOut" };

  const { entryId } = parsed.data;

  return settle(() =>
    withGoalsDb(async (tx) => {
      const entry = await readEntry(tx, entryId);
      if (entry.dismissedAt !== null || entry.allocated) throw new NamedError("day.errors.timeEntryHandled");
      await tx.update(timeEntries).set({ dismissedAt: sql`now()` }).where(eq(timeEntries.id, entryId));
    }),
  );
}

/** Puts a confirmed or dismissed entry back to waiting: its allocations go, and so does «no cuenta». */
export async function undoTimeEntry(input: TimeEntryIdInput): Promise<TimeEntryResult> {
  const parsed = timeEntryIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "day.errors.signedOut" };

  const { entryId } = parsed.data;

  return settle(() =>
    withGoalsDb(async (tx) => {
      await readEntry(tx, entryId);
      await tx.delete(timeAllocations).where(eq(timeAllocations.entryId, entryId));
      await tx
        .update(timeEntries)
        .set({ dismissedAt: null })
        .where(and(eq(timeEntries.id, entryId), sql`${timeEntries.dismissedAt} is not null`));
    }),
  );
}

/**
 * Records time the person told the chat or a connected AI as an entry that waits (RP-151, RP-92, RP-139). The goal,
 * when named, is only suggested: `confirmTimeEntry` places it. A task's own time goes through `recordTaskTime`.
 */
export async function recordTimeEntry(input: RecordTimeEntryInput): Promise<TimeEntryResult & { entryId?: string }> {
  const parsed = recordTimeEntrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "day.errors.signedOut" };

  const { day, minutes, source, goalId, note } = parsed.data;
  const today = todayInZone();
  if (day > today) return { ok: false, error: "day.errors.dayFuture" };
  if (day < earliestPastDay(today)) return { ok: false, error: "day.errors.dayTooOld" };

  let entryId: string | undefined;
  const result = await settle(() =>
    withGoalsDb(async (tx) => {
      if (goalId) {
        const [goal] = await tx.select({ id: goals.id }).from(goals).where(eq(goals.id, goalId));
        if (!goal) throw new NamedError("day.errors.notFound");
      }
      // Named columns only: `created_at` is withheld from `authenticated`.
      const [inserted] = await tx.execute<{ id: string }>(sql`
        insert into ${timeEntries} (user_id, day, minutes, source, suggested_goal_id, note)
        values (${person.id}, ${day}, ${minutes}, ${source}, ${goalId ?? null}, ${note ?? null})
        returning id
      `);
      entryId = inserted.id;
    }),
  );
  return result.ok ? { ...result, entryId } : result;
}
