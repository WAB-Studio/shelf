import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeReviewCursor,
  encodeReviewCursor,
  reviewEntrySchema,
  reviewSyncRequestSchema,
  reviewSyncResponseSchema,
} from "./review-protocol";

const card = {
  due: 1_700_000_060_000,
  stability: 1.5,
  difficulty: 5.2,
  scheduledDays: 1,
  learningSteps: 0,
  reps: 1,
  lapses: 0,
  state: 2,
  lastReview: 1_700_000_000_000,
  introducedOn: "2026-11-12",
};
const entry = (key: string, patch: Record<string, unknown> = {}) => ({ key, at: 1_700_000_000_000, gone: false, card, sense: null, ...patch });
const request = (entries: unknown[]) => ({ readerId: "reader-1", entries, since: null });

test("an entry with a card, a sense or neither passes", () => {
  assert.equal(reviewEntrySchema.safeParse(entry("word")).success, true);
  assert.equal(reviewEntrySchema.safeParse(entry("word", { card: null, sense: { index: 1, signature: "s", chosenAt: 5 } })).success, true);
  assert.equal(reviewEntrySchema.safeParse(entry("word", { card: null })).success, true);
});

test("a deletion that still carries a card or a sense is refused", () => {
  assert.equal(reviewEntrySchema.safeParse(entry("word", { gone: true })).success, false);
  assert.equal(reviewEntrySchema.safeParse(entry("word", { gone: true, card: null, sense: { index: 0, signature: "s", chosenAt: 0 } })).success, false);
  assert.equal(reviewEntrySchema.safeParse(entry("word", { gone: true, card: null })).success, true);
});

test("a key past 500 characters, an empty one or one with a NUL is refused", () => {
  assert.equal(reviewEntrySchema.safeParse(entry("x".repeat(501))).success, false);
  assert.equal(reviewEntrySchema.safeParse(entry("")).success, false);
  assert.equal(reviewEntrySchema.safeParse(entry("a\u0000b")).success, false);
});

test("a card whose numbers cannot be one is refused", () => {
  for (const patch of [{ stability: Number.NaN }, { state: 4 }, { reps: -1 }, { due: 1.5 }, { lastReview: 8_640_000_000_000_001 }]) {
    assert.equal(reviewEntrySchema.safeParse(entry("word", { card: { ...card, ...patch } })).success, false, JSON.stringify(patch));
  }
});

test("two versions of one key in a batch are refused, and a batch holds at most 500", () => {
  assert.equal(reviewSyncRequestSchema.safeParse(request([entry("a"), entry("a", { at: 5 })])).success, false);
  assert.equal(reviewSyncRequestSchema.safeParse(request([entry("a"), entry("b")])).success, true);
  const many = Array.from({ length: 501 }, (_, i) => entry(`k${i}`));
  assert.equal(reviewSyncRequestSchema.safeParse(request(many)).success, false);
  assert.equal(reviewSyncRequestSchema.safeParse(request(many.slice(0, 500))).success, true);
});

test("the answer parses back what the route builds", () => {
  const answer = { accepted: 1, entries: [entry("a"), entry("b", { gone: true, card: null })], cursor: "2026-11-12T10:00:00.123456Z|a" };
  assert.equal(reviewSyncResponseSchema.safeParse(answer).success, true);
});

test("a cursor round-trips, a key holding a bar included", () => {
  for (const key of ["word", "a|b", "two words", "|"]) {
    const cursor = { updatedAt: "2026-11-12T10:00:00.123456Z", key };
    assert.deepEqual(decodeReviewCursor(encodeReviewCursor(cursor)), cursor);
  }
});

test("a cursor this route cannot read is none", () => {
  for (const raw of ["", "nobar", "2026-11-12T10:00:00Z|", "2026-02-31T10:00:00Z|a", "yesterday|a", `2026-11-12T10:00:00Z|${"x".repeat(501)}`]) {
    assert.equal(decodeReviewCursor(raw), null, raw);
  }
});
