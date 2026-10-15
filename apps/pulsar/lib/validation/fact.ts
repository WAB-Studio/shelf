import { z } from "zod";

import { civilDateToDate, dateToCivilDate, isCivilDate, todayInZone } from "@/lib/zone";

// The same shape check `one-off.ts`'s own `civilDate` runs, reused here: a
// caller-supplied day is a real calendar date or refused before it ever
// reaches the range and subject checks below, which assume a well-formed
// string and compare it lexicographically against another one.
const civilDate = (message: string) => z.string().refine(isCivilDate, { error: message });

// How far back a fact may reach (RP-06), in
// exactly one place — the one the date pickers read their floor from, never a second 7 typed beside this one.
export const PAST_DAY_LIMIT = 7;

// The earliest civil day a fact may name, given today's. Goes through `Date`
// and back rather than subtracting on the string: a civil date crosses
// months and years, and a plain digit subtraction does not.
function earliestPastDay(today: string): string {
  const date = civilDateToDate(today);
  date.setUTCDate(date.getUTCDate() - PAST_DAY_LIMIT);
  return dateToCivilDate(date);
}

// Needs only today's own date, never the subject's: a day the person could
// never have meant, whatever it explains. `requireDayForSubject` below
// carries what only the subject itself can say.
function requireDayInRange(data: { day?: string | null }, ctx: z.RefinementCtx) {
  if (data.day == null) return;

  const today = todayInZone();
  if (data.day > today) {
    ctx.addIssue({ code: "custom", message: "day.errors.dayFuture", path: ["day"] });
    return;
  }
  if (data.day < earliestPastDay(today)) {
    ctx.addIssue({ code: "custom", message: "day.errors.dayTooOld", path: ["day"] });
  }
}

// Exactly one subject, mirroring the database's own `facts_one_subject`
// check: a fact explains a commitment or a one-off, never both and never
// neither (§2 «Invariants»).
function requireOneSubject(
  data: { commitmentId?: string | null; oneOffId?: string | null },
  ctx: z.RefinementCtx,
) {
  if ((data.commitmentId != null) === (data.oneOffId != null)) {
    ctx.addIssue({
      code: "custom",
      message: "day.errors.subjectInvalid",
      path: ["commitmentId"],
    });
  }
}

// The commitment's own unit, never typed twice (RP-03): shared by the server
// action and by the sheet's own "escribir otra cantidad" field, so a number
// the client refuses is a number the server would have refused too, and
// nothing types past the schema on either side. Bounded well under
// Postgres's `integer` column's own ceiling (2,147,483,647) — no quantity a
// person types in one day, in any of RP-03's units, plausibly reaches into
// the millions, and a value that large is a mistyped digit, not a real one.
// Left unbounded, that digit would reach the insert and come back as a raw
// `value out of range for type integer` — a 500, not a message.
export const quantitySchema = z
  .number({ error: "day.errors.quantityInvalid" })
  .int({ error: "day.errors.quantityInvalid" })
  .positive({ error: "day.errors.quantityInvalid" })
  .max(1_000_000, { error: "day.errors.quantityInvalid" });

export const declareFactSchema = z
  .object({
    commitmentId: z.uuid({ error: "day.errors.subjectInvalid" }).nullish(),
    oneOffId: z.uuid({ error: "day.errors.subjectInvalid" }).nullish(),
    // Whether this is required at all depends on the commitment's
    // `satisfaction`, which the shape below cannot see — `requireQuantityFor`
    // runs that check on the same schema, once the action has read the
    // commitment it names.
    quantity: quantitySchema.nullish(),
    // The two mistakes from today's monologue (RP-04): offered, never required.
    note: z
      .string()
      .trim()
      .min(1, { error: "day.errors.noteEmpty" })
      .max(280, { error: "day.errors.noteTooLong" })
      .nullish(),
    // Set by `quantity-sheet.tsx`'s own "Cambiar", never by "Anotar": a row
    // that already carries a fact today is replaced whole — that
    // commitment's facts for today deleted, the new one inserted, one
    // transaction — rather than added beside it (RP-03's "one gesture",
    // read back rather than accumulated).
    replace: z.boolean().optional(),
    // The day it happened, when that day is gone (RP-06). Absent means
    // today — the action still decides that from the person's own zone, never
    // from the client (RNP-06); this is only ever a day already past.
    day: civilDate("day.errors.dayInvalid").optional(),
  })
  .superRefine(requireOneSubject)
  .superRefine(requireDayInRange);

export type DeclareFactInput = z.infer<typeof declareFactSchema>;

/**
 * A commitment satisfied by `quantity` has nothing else that satisfies it
 * (RP-03): the number is the whole gesture. Read the commitment's own
 * `satisfaction` first — never guess it from the payload — then run this
 * refinement on the very schema the form used, so a call the form could never
 * produce is refused before it reaches the database's columns, which allow a
 * null quantity on every kind of fact.
 */
export function requireQuantityFor(satisfaction: "tap" | "quantity" | "evidence") {
  return function refine(data: { quantity?: number | null }, ctx: z.RefinementCtx) {
    if (satisfaction === "quantity" && data.quantity == null) {
      ctx.addIssue({
        code: "custom",
        message: "day.errors.quantityRequired",
        path: ["quantity"],
      });
    }
  };
}

/**
 * A caller-supplied day never names a moment its subject could not have had
 * (RP-06): before its goal opened, before a commitment existed, after it was retired, or at all on a
 * one-off — a one-off is done on the day it is done, never redated. Read the
 * subject's own civil days first, never guessed from the payload, then run
 * this refinement on the very schema the action used.
 */
export function requireDayForSubject(
  subject:
    | { kind: "commitment"; openedDay: string; createdDay: string; retiredDay: string | null }
    | { kind: "oneOff" },
) {
  return function refine(data: { day?: string | null }, ctx: z.RefinementCtx) {
    if (data.day == null) return;

    if (subject.kind === "oneOff") {
      ctx.addIssue({ code: "custom", message: "day.errors.dayOnOneOff", path: ["day"] });
      return;
    }

    // The goal's rule is stated first and alone: it names the earlier moment.
    if (data.day < subject.openedDay) {
      ctx.addIssue({ code: "custom", message: "day.errors.dayBeforeGoal", path: ["day"] });
      return;
    }

    if (data.day < subject.createdDay) {
      ctx.addIssue({ code: "custom", message: "day.errors.dayBeforeCommitment", path: ["day"] });
    }
    if (subject.retiredDay != null && data.day > subject.retiredDay) {
      ctx.addIssue({ code: "custom", message: "day.errors.dayAfterRetired", path: ["day"] });
    }
  };
}

export const undoFactSchema = z.object({
  factId: z.uuid({ error: "day.errors.invalid" }),
});

export type UndoFactInput = z.infer<typeof undoFactSchema>;
