"use server";

import { revalidatePath } from "next/cache";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { commitments, facts, goals, oneOffs } from "@/db/schema";
import { pgCode } from "@/lib/db-error";
import { getPerson, withGoalsDb } from "@/lib/session";
import {
  declareFactSchema,
  requireDayForSubject,
  requireQuantityFor,
  undoFactSchema,
  type DeclareFactInput,
  type UndoFactInput,
} from "@/lib/validation/fact";
import { civilDateInZone, todayInZone } from "@/lib/zone";
import { messageKey, type MessageKey } from "@/i18n/translator";
import { NamedError } from "@/lib/actions/named-error";

export type DeclareFactResult = { ok: true; factId: string } | { ok: false; error: MessageKey };
export type UndoFactResult = { ok: true } | { ok: false; error: MessageKey };

/**
 * Writes a fact in one gesture (RP-02, RP-03, RP-04). The day it happened is
 * decided here, from the person's own zone, never taken from the client
 * (RNP-06); the moment it was written is left to the column's own `now()`, so
 * the two are never the same value read twice.
 */
export async function declareFact(input: DeclareFactInput): Promise<DeclareFactResult> {
  const parsed = declareFactSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "day.errors.signedOut" };

  const { commitmentId, oneOffId, quantity, note, replace } = parsed.data;

  try {
    const written = await withGoalsDb(async (tx) => {
      // Absent means today, decided here from the person's own zone, never
      // from the client (RNP-06); present, it is a day already past —
      // `requireDayInRange` (schema) and `requireDayForSubject` (below,
      // once the subject is read) are what keep it inside RP-06's reach.
      const day = parsed.data.day ?? todayInZone();

      // Serialises every write for this (commitment, day).
      // Without it, "Cambiar" racing a plain tap on the same commitment
      // could return a `factId` from a row the other call's own delete had
      // already removed by the time this one's fallback `select` ran: two
      // separate statements, no lock between them, each transaction reading
      // a row the other was free to delete out from under it. A transaction-
      // scoped advisory lock is released at commit, so the loser's whole
      // transaction — delete, insert, fallback select alike — runs only
      // after the winner's has fully landed. A one-off never conflicts on
      // `facts_commitment_day_unique` (it carries no `commitmentId`), so it
      // takes no lock on that index; its own lock, below, serialises the
      // read-then-insert so two marks leave one fact.
      if (commitmentId != null) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${commitmentId}::text || ':' || ${day}, 0))`,
        );
      } else if (oneOffId != null) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${oneOffId}::text || ':once', 0))`,
        );
      }

      let goalId: string | null = null;

      if (commitmentId != null) {
        const [commitment] = await tx
          .select({
            satisfaction: commitments.satisfaction,
            goalId: commitments.goalId,
            openedAt: goals.createdAt,
            createdAt: commitments.createdAt,
            retiredAt: commitments.retiredAt,
          })
          .from(commitments)
          .leftJoin(goals, eq(goals.id, commitments.goalId))
          .where(eq(commitments.id, commitmentId));

        if (!commitment) throw new NamedError("day.errors.notFound");

        // RP-05: a fact for a commitment satisfied by evidence would have no
        // day of its own to explain — that day is drawn from the source, not
        // written here. Refused before the insert, not by a column that would
        // otherwise happily hold it.
        if (commitment.satisfaction === "evidence") {
          throw new NamedError("day.errors.evidenceOnly");
        }

        // RP-06: a caller-supplied day never names a moment this commitment
        // could not have had — read back from the row itself, never guessed.
        const dayCheck = z
          .custom<{ day?: string | null }>()
          .superRefine(
            requireDayForSubject({
              kind: "commitment",
              // A habit with no goal opens the day it was made.
              openedDay: civilDateInZone(commitment.openedAt ?? commitment.createdAt),
              createdDay: civilDateInZone(commitment.createdAt),
              retiredDay: commitment.retiredAt ? civilDateInZone(commitment.retiredAt) : null,
            }),
          )
          .safeParse({ day: parsed.data.day });
        if (!dayCheck.success) {
          throw new NamedError(dayCheck.error.issues[0].message);
        }

        const quantityCheck = z
          .custom<{ quantity?: number | null }>()
          .superRefine(requireQuantityFor(commitment.satisfaction))
          .safeParse({ quantity });
        if (!quantityCheck.success) {
          throw new NamedError(quantityCheck.error.issues[0].message);
        }

        goalId = commitment.goalId;
      } else if (oneOffId != null) {
        const [oneOff] = await tx
          .select({ goalId: oneOffs.goalId })
          .from(oneOffs)
          .where(eq(oneOffs.id, oneOffId));

        if (!oneOff) throw new NamedError("day.errors.notFound");

        // RP-06: a one-off is done on the day it is done, never redated.
        const dayCheck = z
          .custom<{ day?: string | null }>()
          .superRefine(requireDayForSubject({ kind: "oneOff" }))
          .safeParse({ day: parsed.data.day });
        if (!dayCheck.success) {
          throw new NamedError(dayCheck.error.issues[0].message);
        }

        // A one-off done twice keeps the fact it already has: adopted, never
        // written again, whether or not the unique index exists.
        const [done] = await tx.execute<{ id: string; day: string }>(sql`
          select id, day::text as day from ${facts} where one_off_id = ${oneOffId}
        `);
        if (done) return { id: done.id, day: done.day };

        goalId = oneOff.goalId;
      }

      // "Cambiar" (`quantity-sheet.tsx`), never "Anotar": a row that already
      // carries a fact today is replaced whole, in the same transaction as
      // the insert below — delete-then-insert, never an UPDATE (`facts`
      // grants none), and never two separate calls a client could interleave
      // with someone else's read.
      //
      // Adopts first, deletes only when there is something to actually
      // change: the lock above serialises the two writes, but does
      // not by itself say what "replace" should do when it wins the race
      // *after* a concurrent plain tap already landed the very same
      // (commitment, day) row — deleting that row unconditionally would
      // still hand the plain caller a `factId` this transaction had just
      // removed. Reading the existing row first and comparing its own
      // quantity and note mirrors the plain insert's own `on conflict … do
      // nothing`: unchanged data is adopted, not recreated, so two calls
      // racing on a `tap` commitment (no quantity, no note — always
      // identical) never see a row deleted out from under them. A quantity
      // that genuinely differs still deletes and recreates: that is what
      // "Cambiar" is for.
      if (replace && commitmentId != null) {
        const [existing] = await tx.execute<{
          id: string;
          quantity: number | null;
          note: string | null;
        }>(sql`
          select id, quantity, note from ${facts}
          where commitment_id = ${commitmentId} and day = ${day}
        `);

        if (existing) {
          const unchanged =
            existing.quantity === (quantity ?? null) && existing.note === (note ?? null);
          if (unchanged) return { id: existing.id, day };

          await tx.execute(sql`delete from ${facts} where id = ${existing.id}`);
        }
      }

      // Named columns only, never the builder's `.insert()`: it lists every
      // column of the table and fills the rest with `default`, and Postgres
      // checks the grant on a column named that way too — `written_at` is
      // deliberately withheld from `authenticated`, left to the column's own
      // `now()` (RP-06).
      //
      // `facts_commitment_day_unique` is the arbiter for a
      // `commitmentId` insert: two taps racing from two devices both reach
      // this statement, one lands and one conflicts, and `on conflict …
      // do nothing` turns the second into a no-op rather than a 500 — a
      // one-off's insert never carries a `commitmentId`, so it never matches
      // that partial index. Without a target it covers the one-off's own
      // index too, and is correct before that index exists.
      const [inserted] = await tx.execute<{ id: string }>(sql`
        insert into ${facts}
          (user_id, commitment_id, one_off_id, goal_id, day, quantity, note)
        values
          (${person.id}, ${commitmentId ?? null}, ${oneOffId ?? null}, ${goalId},
           ${day}, ${quantity ?? null}, ${note ?? null})
        on conflict do nothing
        returning id
      `);

      if (inserted) return { id: inserted.id, day };

      // The index refused this insert: another device's tap for the same
      // subject and day landed first. Read back its id rather than fail —
      // a second tap from another device is a no-op, never an error.
      const [existing] = await tx.execute<{ id: string }>(
        commitmentId != null
          ? sql`select id from ${facts} where commitment_id = ${commitmentId} and day = ${day}`
          : sql`select id from ${facts} where one_off_id = ${oneOffId}`,
      );
      if (!existing) {
        // Unreachable: the conflict that just fired proves a row is there.
        throw new NamedError("day.errors.notFound");
      }
      return { id: existing.id, day };
    });

    // `/dia/[fecha]`: the day a past fact just landed on has
    // its own route, revalidated by its literal path — never the pattern,
    // which would need a `'page'` `type` this call has no business asking
    // for since the route itself is still unbuilt.
    revalidatePath("/");
    revalidatePath("/semana");
    revalidatePath(`/dia/${written.day}`);
    return { ok: true, factId: written.id };
  } catch (error) {
    if (error instanceof NamedError) return { ok: false, error: messageKey(error.message) };
    // `declareFactSchema`'s own `.max()` (`lib/validation/fact.ts`) refuses a
    // quantity this large before the insert ever runs; this is the second
    // line, not the first — a number the schema missed for any reason still
    // meets Postgres's own `integer` ceiling as a message, never a 500.
    // `pgCode`, not a bare `error.code`: drizzle-orm wraps the driver's error
    // in `DrizzleQueryError` and hangs the real one off `.cause`, so the
    // bare check never fires.
    if (pgCode(error) === "22003") return { ok: false, error: "day.errors.quantityInvalid" };
    throw error;
  }
}

/**
 * Takes a declared fact back (RP-05). Scoped by `(id, userId)` in the query
 * itself, not the policy alone: a fact belonging to someone else, or one that
 * never existed, deletes nothing and reports exactly the same way. A fact
 * whose commitment is satisfied by evidence was never inserted in the first
 * place, so there is no extra case here to refuse it — there is no row.
 */
export async function undoFact(input: UndoFactInput): Promise<UndoFactResult> {
  const parsed = undoFactSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "day.errors.signedOut" };

  const deleted = await withGoalsDb((tx) =>
    tx
      .delete(facts)
      .where(and(eq(facts.id, parsed.data.factId), eq(facts.userId, person.id)))
      .returning({ id: facts.id }),
  );

  if (deleted.length === 0) return { ok: false, error: "day.errors.notFound" };

  revalidatePath("/");
  return { ok: true };
}
