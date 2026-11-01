import { z } from "zod";

import { civilDate } from "./civil-date";

export const GOAL_NAME_MAX = 120;

// RP-56: the id a client mints once per create and resends when the answer was lost. Never typed
// by a person, so its refusal borrows a generic sentence.
const requestId = z.uuid({ error: "plan.errors.notFound" }).optional();

export const createGoalSchema = z.object({
  // Two fields, no measure (§0.3, 3): the measure columns land null and are
  // named later, by the first commitment that measures something.
  name: z
    .string({ error: "plan.errors.nameEmpty" })
    .trim()
    .min(1, { error: "plan.errors.nameEmpty" })
    .max(GOAL_NAME_MAX, { error: "plan.errors.nameTooLong" }),
  // Absent or null: a goal with no end (RP-99).
  horizon: civilDate("plan.errors.horizonInvalid").nullable().default(null),
  // The goal it opens inside (RP-78); absent for a goal on its own.
  parentId: z.uuid({ error: "plan.errors.goalInvalid" }).optional(),
  requestId,
});

export type CreateGoalInput = z.infer<typeof createGoalSchema>;

// The aim and span of a phase, shared by adding and editing one.
export const phaseFields = {
  aim: z
    .string({ error: "plan.errors.aimEmpty" })
    .trim()
    .min(1, { error: "plan.errors.aimEmpty" })
    .max(200, { error: "plan.errors.aimTooLong" }),
  startsOn: civilDate("plan.errors.startsOnInvalid"),
  endsOn: civilDate("plan.errors.endsOnInvalid"),
};

// Mirrors `phases_ends_on_after_starts_on`: a backwards phase is refused
// here, not by the database's own CHECK.
export const phaseNotBackwards = {
  check: (data: { startsOn: string; endsOn: string }) => data.endsOn >= data.startsOn,
  params: { error: "plan.errors.phaseBackwards", path: ["endsOn"] },
};

export const addPhaseSchema = z
  .object({ goalId: z.uuid({ error: "plan.errors.goalInvalid" }), ...phaseFields, requestId })
  .refine(phaseNotBackwards.check, phaseNotBackwards.params);

export type AddPhaseInput = z.infer<typeof addPhaseSchema>;

export type PhaseSpan = { startsOn: string; endsOn: string };

// Whether two phases would share a day (RP-15): `phaseOn` (lib/day/derive.ts)
// answers "which phase is today in" by taking the first span that covers the
// day, so two spans covering the same day would make it guess. Inclusive at
// both ends — a phase ending the day another starts still shares that day.
export function phasesOverlap(a: PhaseSpan, b: PhaseSpan): boolean {
  return a.startsOn <= b.endsOn && b.startsOn <= a.endsOn;
}

// Whether a span's own last day still falls within the goal's horizon
// (RP-11, RP-15): a goal names one horizon, and a phase is a span *of* it,
// never past it; a phase may end on the horizon itself (RP-25). Compared as civil dates, never as week numbers — the
// horizon is stored as a date, and this holds regardless of which week
// convention drew the span.
export function phaseWithinHorizon(span: PhaseSpan, horizon: string | null): boolean {
  return horizon === null || span.endsOn <= horizon;
}

// RP-12's five cadences, keyed on `cadenceKind` so an impossible column never
// reaches the database: `weekdays` asks for the days it names and nothing
// else, the three counted kinds ask for their count and nothing else, and
// `daily` asks for nothing at all. The ISO range and non-empty rules mirror
// `commitments_weekdays_iso_range` and `commitments_weekdays_for_weekdays`.
export const cadenceSchema = z.discriminatedUnion("cadenceKind", [
  z.object({ cadenceKind: z.literal("daily") }),
  z.object({
    cadenceKind: z.literal("weekdays"),
    // ISO 8601: 1 = Monday, 7 = Sunday — the app's one numbering
    // (`lib/day/cadence.ts`'s `weekdayOf`), never `Date#getUTCDay`'s.
    cadenceWeekdays: z
      .array(
        z
          .number({ error: "plan.errors.weekdayInvalid" })
          .int({ error: "plan.errors.weekdayInvalid" })
          .min(1, { error: "plan.errors.weekdayInvalid" })
          .max(7, { error: "plan.errors.weekdayInvalid" }),
      )
      .min(1, { error: "plan.errors.weekdaysEmpty" }),
  }),
  // What a week (7) and a year (365) hold; a month holds at most 31 days. The
  // bound lives here alone: a commitment stored outside it still loads.
  z.object({
    cadenceKind: z.literal("times_per_week"),
    cadenceN: z
      .number({ error: "plan.errors.timesPerWeekInvalid" })
      .int({ error: "plan.errors.timesPerWeekInvalid" })
      .min(1, { error: "plan.errors.timesPerWeekInvalid" })
      .max(7, { error: "plan.errors.timesPerWeekInvalid" }),
  }),
  z.object({
    cadenceKind: z.literal("every_n_days"),
    cadenceN: z
      .number({ error: "plan.errors.everyNDaysInvalid" })
      .int({ error: "plan.errors.everyNDaysInvalid" })
      .min(1, { error: "plan.errors.everyNDaysInvalid" })
      .max(365, { error: "plan.errors.everyNDaysInvalid" }),
  }),
  z.object({
    cadenceKind: z.literal("times_per_month"),
    cadenceN: z
      .number({ error: "plan.errors.timesPerMonthInvalid" })
      .int({ error: "plan.errors.timesPerMonthInvalid" })
      .min(1, { error: "plan.errors.timesPerMonthInvalid" })
      .max(31, { error: "plan.errors.timesPerMonthInvalid" }),
  }),
]);

// RP-02/RP-03/RP-07's three ways a day is satisfied, keyed on `satisfaction`
// so a `quantity` with no unit or an `evidence` with no source never reaches
// the database — mirrors `commitments_quantity_for_quantity` and
// `commitments_source_for_evidence`. `sourceKey` names a row of
// `goals.evidence_sources`; resolving it to an id is the action's job, run
// inside the same transaction as the insert (RNP-10).
const satisfactionSchema = z.discriminatedUnion("satisfaction", [
  z.object({ satisfaction: z.literal("tap") }),
  z.object({
    satisfaction: z.literal("quantity"),
    // Same ceiling as a declared day's own quantity (`lib/validation/fact.ts`):
    // the target and the day's tally live in the same unit, so one bound
    // serves both and a huge target never reaches the `integer` column raw.
    targetQuantity: z
      .number({ error: "plan.errors.targetQuantityInvalid" })
      .int({ error: "plan.errors.targetQuantityInvalid" })
      .positive({ error: "plan.errors.targetQuantityInvalid" })
      .max(1_000_000, { error: "plan.errors.targetQuantityInvalid" }),
    // The person's own word for what is counted — stored as they wrote it,
    // never resolved against a catalogue (AGENTS.md «## Code»).
    unit: z
      .string({ error: "plan.errors.unitEmpty" })
      .trim()
      .min(1, { error: "plan.errors.unitEmpty" })
      .max(40, { error: "plan.errors.unitTooLong" }),
  }),
  z.object({
    satisfaction: z.literal("evidence"),
    sourceKey: z
      .string({ error: "plan.errors.sourceKeyEmpty" })
      .trim()
      .min(1, { error: "plan.errors.sourceKeyEmpty" }),
    threshold: z
      .number({ error: "plan.errors.thresholdInvalid" })
      .int({ error: "plan.errors.thresholdInvalid" })
      .min(1, { error: "plan.errors.thresholdInvalid" })
      .max(1_000_000, { error: "plan.errors.thresholdInvalid" }),
  }),
]);

export const addCommitmentSchema = z.intersection(
  z.intersection(
    z.object({
      // Absent: a habit with no goal (RP-100).
      goalId: z.uuid({ error: "plan.errors.goalInvalid" }).optional(),
      name: z
        .string({ error: "plan.errors.nameEmpty" })
        .trim()
        .min(1, { error: "plan.errors.nameEmpty" })
        .max(120, { error: "plan.errors.nameTooLong" }),
      // A habit's note, as a task's (RP-88): blank is no note. Mirrors `commitments_note_shape`.
      note: z
        .string()
        .trim()
        .max(2000, { error: "plan.errors.noteTooLong" })
        .transform((value) => (value === "" ? undefined : value))
        .optional(),
      requestId,
    }),
    cadenceSchema,
  ),
  satisfactionSchema,
);

export type AddCommitmentInput = z.infer<typeof addCommitmentSchema>;

// Rename a habit and rewrite its note. Cadence, satisfaction and quantity are not fields: zod drops them.
export const editHabitSchema = z.object({
  commitmentId: z.uuid({ error: "plan.errors.commitmentInvalid" }),
  name: z
    .string({ error: "plan.errors.nameEmpty" })
    .trim()
    .min(1, { error: "plan.errors.nameEmpty" })
    .max(120, { error: "plan.errors.nameTooLong" }),
  note: z
    .string()
    .trim()
    .max(2000, { error: "plan.errors.noteTooLong" })
    .transform((value) => (value === "" ? null : value)),
});

export type EditHabitInput = z.infer<typeof editHabitSchema>;

export const retireCommitmentSchema = z.object({
  commitmentId: z.uuid({ error: "plan.errors.commitmentInvalid" }),
});

export type RetireCommitmentInput = z.infer<typeof retireCommitmentSchema>;

// RP-23: the same rules as `createGoalSchema`'s own name field — trimmed,
// required, 120 characters — shared here rather than duplicated, since a
// goal is asked for its name in both places.
export const renameGoalSchema = z.object({
  goalId: z.uuid({ error: "plan.errors.goalInvalid" }),
  name: z
    .string({ error: "plan.errors.nameEmpty" })
    .trim()
    .min(1, { error: "plan.errors.nameEmpty" })
    .max(120, { error: "plan.errors.nameTooLong" }),
});

export type RenameGoalInput = z.infer<typeof renameGoalSchema>;

// RP-24: archiving and reopening name nothing but the goal itself — the
// grant layer (`db/migrations/0004_melodic_dreadnoughts.sql`) is what keeps
// either from moving any other column.
export const archiveGoalSchema = z.object({
  goalId: z.uuid({ error: "plan.errors.goalInvalid" }),
});

export type ArchiveGoalInput = z.infer<typeof archiveGoalSchema>;

export const reopenGoalSchema = z.object({
  goalId: z.uuid({ error: "plan.errors.goalInvalid" }),
});

export type ReopenGoalInput = z.infer<typeof reopenGoalSchema>;

// RP-79: a goal goes under another or back to the top (`null`).
export const moveGoalSchema = z.object({
  goalId: z.uuid({ error: "plan.errors.goalInvalid" }),
  parentId: z.uuid({ error: "plan.errors.goalInvalid" }).nullable(),
});

export type MoveGoalInput = z.infer<typeof moveGoalSchema>;

export const GOAL_NOTE_MAX = 100000;

// RP-95: plain text; blank is no note. Mirrors `goals_note_shape`.
export const setGoalNoteSchema = z.object({
  goalId: z.uuid({ error: "plan.errors.goalInvalid" }),
  note: z
    .string({ error: "plan.errors.notFound" })
    .trim()
    .max(GOAL_NOTE_MAX, { error: "tree.errors.noteTooLong" })
    .transform((value) => (value === "" ? null : value)),
});

export type SetGoalNoteInput = z.input<typeof setGoalNoteSchema>;
