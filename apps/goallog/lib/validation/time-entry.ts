import { z } from "zod";

import { civilDate } from "./civil-date";
import { quantitySchema } from "./fact";

// Where some of an entry's minutes go (RP-151).
const allocationSchema = z.object({
  goalId: z.uuid({ error: "day.errors.invalid" }),
  minutes: quantitySchema,
});

export type AllocationInput = z.infer<typeof allocationSchema>;

// One allocation confirms an entry as it was suggested or for another goal; several split it. A goal appears once:
// two lines for one goal are one line with their sum.
const allocationsSchema = z
  .array(allocationSchema, { error: "day.errors.timeAllocationInvalid" })
  .min(1, { error: "day.errors.timeAllocationInvalid" })
  .max(20, { error: "day.errors.timeAllocationInvalid" })
  .refine((lines) => new Set(lines.map((line) => line.goalId)).size === lines.length, {
    error: "day.errors.timeAllocationInvalid",
  });

export const confirmTimeEntrySchema = z.object({
  entryId: z.uuid({ error: "day.errors.invalid" }),
  allocations: allocationsSchema,
});

export type ConfirmTimeEntryInput = z.infer<typeof confirmTimeEntrySchema>;

export const timeEntryIdSchema = z.object({
  entryId: z.uuid({ error: "day.errors.invalid" }),
});

export type TimeEntryIdInput = z.infer<typeof timeEntryIdSchema>;

// Time the person tells the chat or an AI (RP-151, RP-92): it waits as an entry, the goal it names only suggested.
export const recordTimeEntrySchema = z.object({
  day: civilDate("day.errors.invalid"),
  minutes: quantitySchema,
  source: z.enum(["chat", "timelog"], { error: "day.errors.invalid" }),
  goalId: z.uuid({ error: "day.errors.invalid" }).nullish(),
  note: z
    .string()
    .trim()
    .min(1, { error: "day.errors.noteEmpty" })
    .max(280, { error: "day.errors.noteTooLong" })
    .nullish(),
});

export type RecordTimeEntryInput = z.infer<typeof recordTimeEntrySchema>;

/**
 * Whether an entry's allocations settle it whole (RP-151): `short` leaves minutes nowhere, `over` places more than
 * the entry holds. The server reads the entry's minutes under its lock; the tray reads them to enable «Confirmar».
 */
export function settlement(entryMinutes: number, allocations: readonly { minutes: number }[]): "exact" | "short" | "over" {
  const placed = allocations.reduce((total, line) => total + line.minutes, 0);
  if (placed === entryMinutes) return "exact";
  return placed < entryMinutes ? "short" : "over";
}
