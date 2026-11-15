import { z } from "zod";

// The wire format of the review's copy (RL-93), carried inside the record's own sync round (`./protocol`). The
// client driver and the route handler both import this file, so the shape a `fetch` sends is the shape the
// handler parses.

// Entries a round carries each way. The record's own bound is `SYNC_BATCH` (`./protocol`, which imports this file).
export const REVIEW_BATCH = 500;

// Entries one reader may hold in the account, one per word or phrase. A bound on what a signed-in caller can
// write into the shared database, like the record's daily cap.
export const REVIEW_ENTRY_CAP = 20_000;

const MAX_EPOCH_MS = 8_640_000_000_000_000;
const epochMs = z.int().min(0).max(MAX_EPOCH_MS);
const count = z.int().min(0).max(2_147_483_647);
// Postgres refuses a NUL in text and in jsonb: past the schema it would be a 500, not a bad request.
const noNul = (value: string) => !value.includes("\u0000");

// `ReviewCard` (`lib/review/schedule.ts`) without its key, which the entry carries.
export const reviewCardSchema = z.object({
  due: epochMs,
  stability: z.number().finite().min(0).max(1e9),
  difficulty: z.number().finite().min(0).max(1e3),
  scheduledDays: count,
  learningSteps: count,
  reps: count,
  lapses: count,
  state: z.int().min(0).max(3),
  lastReview: epochMs.nullable(),
  introducedOn: z.string().max(10),
});

// `SenseChoice` (`lib/review/store.ts`) without its key. `chosenAt` is the tap's own moment: 0 for a tap kept
// before it was recorded.
export const reviewSenseSchema = z.object({
  index: z.int().min(-1).max(10_000),
  signature: z.string().max(4_000).refine(noNul),
  chosenAt: epochMs,
});

// One word's place in the review, as it travels. `at` orders two versions of the same key (RL-93): the later
// replaces the earlier, and a deletion (`gone`) carries neither half.
export const reviewEntrySchema = z
  .object({
    key: z.string().min(1).max(500).refine(noNul),
    at: epochMs,
    gone: z.boolean(),
    card: reviewCardSchema.nullable(),
    sense: reviewSenseSchema.nullable(),
  })
  .refine((entry) => !entry.gone || (entry.card === null && entry.sense === null), { message: "a deletion is bare" });

// The review's half of a sync round (RL-93), carried in the record's own request and answer. `since` is the
// server's cursor for what this device already merged.
export const reviewRequestSchema = z.object({
  entries: z
    .array(reviewEntrySchema)
    .max(REVIEW_BATCH)
    .refine((entries) => new Set(entries.map((entry) => entry.key)).size === entries.length, { message: "one version per key" }),
  since: z.string().min(1).nullable(),
});

// `full` is a reader at the bound `REVIEW_ENTRY_CAP`: nothing sent was kept, and the device sends it again.
export const reviewAnswerSchema = z.object({
  accepted: z.int(),
  full: z.boolean(),
  entries: z.array(reviewEntrySchema),
  cursor: z.string().min(1).nullable(),
});

export type ReviewWireEntry = z.infer<typeof reviewEntrySchema>;
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;
export type ReviewAnswer = z.infer<typeof reviewAnswerSchema>;

// The tuple a cursor names: the last entry's server clock and its key, which ties break on. `updatedAt` is the
// UTC text the server printed, never a `Date`: a round trip through one would drop the microseconds (docs/TRAPS.md).
export type ReviewCursor = { updatedAt: string; key: string };

const CURSOR_AT =
  /^(?!0000)\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?Z$/;

// A key may hold any character, "|" included, so the split is at the first one: a timestamp has none.
export function encodeReviewCursor(cursor: ReviewCursor): string {
  return `${cursor.updatedAt}|${cursor.key}`;
}

// A cursor this route cannot read is none: a full re-download, harmless because the merge is idempotent.
export function decodeReviewCursor(raw: string): ReviewCursor | null {
  const split = raw.indexOf("|");
  if (split < 0) return null;
  const updatedAt = raw.slice(0, split);
  const key = raw.slice(split + 1);
  if (!CURSOR_AT.test(updatedAt) || key.length === 0 || key.length > 500) return null;
  if (new Date(updatedAt).toISOString().slice(0, 10) !== updatedAt.slice(0, 10)) return null;
  return { updatedAt, key };
}
