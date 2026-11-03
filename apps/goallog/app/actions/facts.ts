"use server";

import { revalidatePath } from "next/cache";

import { and, eq, gte } from "drizzle-orm";

import { facts } from "@/db/schema";
import { writeFact } from "@/lib/actions/write-fact";
import { pgCode } from "@/lib/db-error";
import { getPerson, withGoalsDb } from "@/lib/session";
import {
  declareFactSchema,
  undoFactSchema,
  type DeclareFactInput,
  type UndoFactInput,
} from "@/lib/validation/fact";
import { writableFrom } from "@/lib/plan/closed-month-marks";
import { todayInZone } from "@/lib/zone";
import { messageKey, type MessageKey } from "@/i18n/translator";
import { NamedError } from "@/lib/actions/named-error";

// `values`: what another device already noted for the day, kept, in the habit's unit (RP-03).
export type DeclareFactResult =
  | { ok: true; factId: string }
  | { ok: false; error: MessageKey; values?: { quantity: number; unit: string | null } };
export type UndoFactResult = { ok: true } | { ok: false; error: MessageKey };

/**
 * Writes a fact in one gesture (RP-02, RP-03, RP-04). The day it happened is
 * decided here, from the person's own zone, never taken from the client
 * (RNP-06); the moment it was written is left to the column's own `now()`, so
 * the two are never the same value read twice.
 *
 * `namesParent` is `completeOneOff`'s: a parent is refused by name, read under
 * the task's lock in this one transaction. Bare, `facts_insert_self` refuses
 * it as a 42501. Plain data, so a client that sends it only gets the name.
 */
export async function declareFact(
  input: DeclareFactInput,
  { namesParent = false }: { namesParent?: boolean } = {},
): Promise<DeclareFactResult> {
  const parsed = declareFactSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messageKey(parsed.error.issues[0].message) };

  const person = await getPerson();
  if (!person) return { ok: false, error: "day.errors.signedOut" };

  try {
    const written = await withGoalsDb((tx) => writeFact(tx, person.id, parsed.data, namesParent));

    // `/dia/[fecha]`: the day a past fact just landed on has
    // its own route, revalidated by its literal path — never the pattern,
    // which would need a `'page'` `type` this call has no business asking
    // for since the route itself is still unbuilt.
    if ("kept" in written) return { ok: false, error: "day.errors.alreadyNoted", values: { quantity: written.kept, unit: written.unit } };

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

  // A closed month past a fact's reach reads only (RP-143): its facts stay, as its screens show them.
  const floor = writableFrom(todayInZone());
  const outcome = await withGoalsDb(async (tx) => {
    const own = and(eq(facts.id, parsed.data.factId), eq(facts.userId, person.id));
    const deleted = await tx.delete(facts).where(and(own, gte(facts.day, floor))).returning({ id: facts.id });
    if (deleted.length > 0) return "undone";
    const kept = await tx.select({ id: facts.id }).from(facts).where(own);
    return kept.length > 0 ? "closed" : "missing";
  });

  if (outcome === "closed") return { ok: false, error: "day.errors.monthClosed" };
  if (outcome === "missing") return { ok: false, error: "day.errors.notFound" };

  revalidatePath("/");
  return { ok: true };
}
