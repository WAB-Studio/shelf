import { z } from "zod";

// A month holds 44 640 minutes at most: the cap of a time unit, which the action judges and the form mirrors.
export const MAX_TIME_RHYTHM = 44_640;

const goalId = z.uuid({ error: "month.errors.invalid" });

export const setRhythmSchema = z.object({
  goalId,
  // A month's amount in the goal's own unit; the cap is the column's check, and time is capped by the action.
  amount: z
    .number({ error: "roadmap.errors.rhythmRange" })
    .int({ error: "roadmap.errors.rhythmRange" })
    .min(1, { error: "roadmap.errors.rhythmRange" })
    .max(1_000_000, { error: "roadmap.errors.rhythmRange" }),
}, { error: "month.errors.invalid" });

export type SetRhythmInput = z.infer<typeof setRhythmSchema>;

const noticeMonth = z
  .string({ error: "month.errors.monthInvalid" })
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: "month.errors.monthInvalid" });

export const dismissPlanNoticeSchema = z.object({ goalId, month: noticeMonth });

export const dismissPlanNoticesSchema = z.object({
  notices: z
    .array(dismissPlanNoticeSchema, { error: "month.errors.invalid" })
    .min(1, { error: "month.errors.invalid" })
    .max(50, { error: "month.errors.invalid" }),
});

export type DismissPlanNoticesInput = z.infer<typeof dismissPlanNoticesSchema>;

export type DismissPlanNoticeInput = z.infer<typeof dismissPlanNoticeSchema>;

