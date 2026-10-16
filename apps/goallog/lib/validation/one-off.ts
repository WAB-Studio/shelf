import { z } from "zod";

import { setMonthBudgetSchema } from "@/lib/validation/budget";
import { isCivilDate, todayInZone } from "@/lib/zone";

// A day the person named for their errand, never one already gone: a past
// one is refused (RP-19). Today is read at parse time, not at import.
const civilDate = (message: string) => z.string().refine(isCivilDate, { error: message });
const futureOrToday = (day: string) => day >= todayInZone();
const oneOffDay = () =>
  civilDate("day.errors.oneOffDayInvalid").refine(futureOrToday, {
    error: "day.errors.oneOffDayPast",
  });

// One rule for the act, the template and the AI (RP-45): line breaks kept,
// ends trimmed, empty is no note. The length is judged after normalising.
export const noteSchema = z
  .string({ error: "day.errors.oneOffNoteTooLong" })
  .transform((text) => text.replace(/\r\n/g, "\n").trim())
  .pipe(z.string().max(2000, { error: "day.errors.oneOffNoteTooLong" }))
  .transform((text) => (text === "" ? null : text))
  .nullable();

export const createOneOffSchema = z.object({
  name: z
    .string({ error: "day.errors.oneOffNameEmpty" })
    .trim()
    .min(1, { error: "day.errors.oneOffNameEmpty" })
    .max(120, { error: "day.errors.oneOffNameTooLong" }),
  // Null is a one-off with no day yet (RP-59), dated later by `scheduleOneOff`.
  day: oneOffDay().nullable(),
  // Absent, a one-off belongs to nothing (RP-20) and its week is still shown.
  goalId: z.uuid({ error: "plan.errors.goalInvalid" }).nullish(),
  // In the goal's measure unit (RP-30); the server refuses a goal with none.
  estimate: z
    .number({ error: "month.errors.estimateInvalid" })
    .int({ error: "month.errors.estimateInvalid" })
    .min(1, { error: "month.errors.estimateInvalid" })
    .max(1_000_000, { error: "month.errors.estimateInvalid" })
    .nullish(),
  // "YYYY-MM", the same month the amount sheet speaks in (RP-31).
  plannedMonth: setMonthBudgetSchema.shape.month.nullish(),
  // The child takes its parent's goal and month, so it names neither.
  parentId: z.uuid({ error: "month.errors.invalid" }).nullish(),
  note: noteSchema.nullish(),
  // A task of the goal's plan with no month of its own: the plan places it (RP-50).
  inPlan: z.boolean({ error: "month.errors.invalid" }).optional(),
})
  .refine((input) => !input.inPlan || (input.goalId != null && input.day == null && input.parentId == null), {
    error: "month.errors.invalid",
  })
  .refine((input) => input.plannedMonth == null || input.goalId != null, {
    error: "month.errors.invalid",
  })
  // A month task takes its day later, through `scheduleOneOff`.
  .refine((input) => input.plannedMonth == null || input.day == null, {
    error: "month.errors.invalid",
  })
  .refine((input) => input.parentId == null || (input.plannedMonth == null && input.goalId == null), {
    error: "month.errors.invalid",
  })
  // A one-off of no goal measures nothing (`one_offs_estimate_needs_goal`).
  .refine((input) => input.estimate == null || input.goalId != null || input.parentId != null, {
    error: "month.errors.noMeasure",
  });

export type CreateOneOffInput = z.infer<typeof createOneOffSchema>;

export const scheduleOneOffSchema = z.object({
  oneOffId: z.uuid({ error: "day.errors.invalid" }),
  day: oneOffDay(),
});

export type ScheduleOneOffInput = z.infer<typeof scheduleOneOffSchema>;

export const completeOneOffSchema = z.object({
  oneOffId: z.uuid({ error: "day.errors.invalid" }),
  // A day already past, up to PAST_DAY_LIMIT back (RP-129); absent is today.
  day: civilDate("day.errors.dayInvalid").optional(),
});

export type CompleteOneOffInput = z.infer<typeof completeOneOffSchema>;

export const deleteOneOffSchema = z.object({
  oneOffId: z.uuid({ error: "day.errors.invalid" }),
});

export type DeleteOneOffInput = z.infer<typeof deleteOneOffSchema>;

const taskName = z
  .string({ error: "roadmap.errors.nameEmpty" })
  .trim()
  .min(1, { error: "roadmap.errors.nameEmpty" })
  .max(120, { error: "roadmap.errors.nameTooLong" });

const taskEstimate = z
  .number({ error: "month.errors.estimateInvalid" })
  .int({ error: "month.errors.estimateInvalid" })
  .min(1, { error: "month.errors.estimateInvalid" })
  .max(1_000_000, { error: "month.errors.estimateInvalid" });

// The sheet's one act (RP-55). Absent leaves a field; `null` clears the
// estimate and returns the month to the plan (RP-51).
export const editTaskSchema = z.object({
  oneOffId: z.uuid({ error: "month.errors.invalid" }),
  name: taskName,
  estimate: taskEstimate.nullish(),
  month: setMonthBudgetSchema.shape.month.nullish(),
});

export type EditTaskInput = z.input<typeof editTaskSchema>;

// The month half of `editTask`, for the AI (RP-51): null unfixes.
export const fixTaskSchema = z.object({
  oneOffId: z.uuid({ error: "month.errors.invalid" }),
  month: setMonthBudgetSchema.shape.month.nullable(),
});

export type FixTaskInput = z.infer<typeof fixTaskSchema>;

export const setOneOffNoteSchema = z.object({
  oneOffId: z.uuid({ error: "day.errors.invalid" }),
  note: noteSchema,
});

export type SetOneOffNoteInput = z.input<typeof setOneOffNoteSchema>;
