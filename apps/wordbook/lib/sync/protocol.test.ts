import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  decodeCursor,
  encodeCursor,
  SYNC_BATCH,
  SYNC_DAILY_ROW_CAP,
  syncRequestSchema,
  syncResponseSchema,
  syncRowSchema,
  tombstoneSchema,
  type SyncRow,
} from "./protocol";

function row(deviceId: string, localId: number): SyncRow {
  return {
    deviceId,
    localId,
    at: 1_700_000_000_000,
    text: "x",
    normalised: "x",
    kind: "word",
    outcome: "exact",
    headword: null,
    rule: null,
    senses: 0,
    translation: null,
    dictionaryReady: true,
    origin: null,
    recordSchema: 1,
  };
}

test("a batch whose rows come from two devices is refused", () => {
  const one = randomUUID();
  const two = randomUUID();
  const parsed = syncRequestSchema.safeParse({ deviceId: one, readerId: "reader-1", rows: [row(one, 1), row(two, 1)], since: null });
  assert.equal(parsed.success, false);
});

test("a batch from one device passes, the empty one too", () => {
  const one = randomUUID();
  assert.equal(syncRequestSchema.safeParse({ deviceId: one, readerId: "reader-1", rows: [row(one, 1), row(one, 2)], since: null }).success, true);
  assert.equal(syncRequestSchema.safeParse({ deviceId: one, readerId: "reader-1", rows: [], since: null }).success, true);
});

test("an `at` past the largest Date is refused", () => {
  const one = randomUUID();
  const late = { ...row(one, 1), at: 9e15 };
  assert.equal(syncRequestSchema.safeParse({ deviceId: one, readerId: "reader-1", rows: [late], since: null }).success, false);
});

test("a row whose outcome is unlisted passes, an unknown outcome does not", () => {
  const one = randomUUID();
  assert.equal(syncRowSchema.safeParse({ ...row(one, 1), outcome: "unlisted" }).success, true);
  assert.equal(syncRowSchema.safeParse({ ...row(one, 1), outcome: "nope" }).success, false);
});

test("a batch admits 500 rows and refuses 501", () => {
  const one = randomUUID();
  const batch = (count: number) => ({
    deviceId: one,
    readerId: "reader-1",
    rows: Array.from({ length: count }, (_, index) => row(one, index + 1)),
    since: null,
  });
  assert.equal(syncRequestSchema.safeParse(batch(500)).success, true);
  assert.equal(syncRequestSchema.safeParse(batch(501)).success, false);
  assert.equal(SYNC_BATCH, 500);
});

test("a reader may send 20 000 rows a day", () => {
  assert.equal(SYNC_DAILY_ROW_CAP, 20_000);
});

test("definition and examples admit 500 characters and refuse 501", () => {
  const one = randomUUID();
  for (const field of ["definition", "exampleEn", "exampleEs"] as const) {
    assert.equal(syncRowSchema.safeParse({ ...row(one, 1), [field]: "x".repeat(500) }).success, true, field);
    assert.equal(syncRowSchema.safeParse({ ...row(one, 1), [field]: "x".repeat(501) }).success, false, field);
  }
});

test("a request row without the three fields still passes", () => {
  const one = randomUUID();
  assert.equal(syncRequestSchema.safeParse({ deviceId: one, readerId: "reader-1", rows: [row(one, 1)], since: null }).success, true);
});

test("500 rows with the three fields at 500 characters serialise under 4 MB", () => {
  const one = randomUUID();
  const full = (localId: number): SyncRow => ({
    ...row(one, localId),
    text: "x".repeat(500),
    normalised: "x".repeat(500),
    headword: "x".repeat(500),
    definition: "x".repeat(500),
    exampleEn: "x".repeat(500),
    exampleEs: "x".repeat(500),
  });
  const batch = { deviceId: one, readerId: "reader-1", rows: Array.from({ length: SYNC_BATCH }, (_, index) => full(index + 1)), since: null };
  assert.equal(syncRequestSchema.safeParse(batch).success, true);
  assert.ok(JSON.stringify(batch).length < 4 * 1024 * 1024);
});

const marks = (device: string, count: number) => Array.from({ length: count }, (_, index) => ({ deviceId: device, localId: index + 1 }));

test("a request written before tombstones existed parses, with none named and no mark cursor", () => {
  const one = randomUUID();
  const parsed = syncRequestSchema.safeParse({ deviceId: one, readerId: "reader-1", rows: [], since: null });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data?.tombstones, []);
  assert.equal(parsed.data?.tombstonesSince, null);
});

test("a request names up to 500 tombstones and refuses 501", () => {
  const one = randomUUID();
  const body = (count: number) => ({ deviceId: one, readerId: "reader-1", rows: [], since: null, tombstones: marks(one, count), tombstonesSince: null });
  assert.equal(syncRequestSchema.safeParse(body(SYNC_BATCH)).success, true);
  assert.equal(syncRequestSchema.safeParse(body(SYNC_BATCH + 1)).success, false);
});

test("a tombstone names a device uuid and a positive int4 local id, and nothing else passes", () => {
  const one = randomUUID();
  assert.equal(tombstoneSchema.safeParse({ deviceId: one, localId: 1 }).success, true);
  assert.equal(tombstoneSchema.safeParse({ deviceId: one, localId: 2_147_483_647 }).success, true);
  for (const bad of [
    { deviceId: one, localId: 0 },
    { deviceId: one, localId: -3 },
    { deviceId: one, localId: 1.5 },
    { deviceId: one, localId: 2_147_483_648 },
    { deviceId: "not-a-uuid", localId: 1 },
    { deviceId: one },
  ]) {
    assert.equal(tombstoneSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("a request with a bad tombstone is refused whole", () => {
  const one = randomUUID();
  const body = { deviceId: one, readerId: "reader-1", rows: [], since: null, tombstones: [{ deviceId: one, localId: 0 }] };
  assert.equal(syncRequestSchema.safeParse(body).success, false);
});

test("a mark cursor must be a non-empty string or null", () => {
  const one = randomUUID();
  const base = { deviceId: one, readerId: "reader-1", rows: [], since: null };
  assert.equal(syncRequestSchema.safeParse({ ...base, tombstonesSince: "" }).success, false);
  assert.equal(syncRequestSchema.safeParse({ ...base, tombstonesSince: 7 }).success, false);
  assert.equal(syncRequestSchema.safeParse({ ...base, tombstonesSince: "2026-10-16T00:00:00.5Z|x|1" }).success, true);
});

test("a response written before tombstones existed parses, with none and no cursor", () => {
  const parsed = syncResponseSchema.safeParse({ accepted: 0, rows: [], cursor: null });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data?.tombstones, []);
  assert.equal(parsed.data?.tombstoneCursor, null);
});

test("a response carries the marks and the cursor of the last one", () => {
  const one = randomUUID();
  const cursor = encodeCursor({ receivedAt: "2026-10-16T01:02:03.123456Z", deviceId: one, localId: 4 });
  const parsed = syncResponseSchema.safeParse({ accepted: 0, rows: [], cursor: null, tombstones: marks(one, 2), tombstoneCursor: cursor });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.tombstones.length, 2);
  assert.deepEqual(decodeCursor(parsed.data?.tombstoneCursor ?? ""), { receivedAt: "2026-10-16T01:02:03.123456Z", deviceId: one, localId: 4 });
  assert.equal(syncResponseSchema.safeParse({ accepted: 0, rows: [], cursor: null, tombstones: [], tombstoneCursor: "" }).success, false);
  assert.equal(syncResponseSchema.safeParse({ accepted: 0, rows: [], cursor: null, tombstones: [{ deviceId: "x", localId: 1 }] }).success, false);
});

test("a row with localId 0 or a negative senses count is refused, the floors pass", () => {
  const one = randomUUID();
  assert.equal(syncRowSchema.safeParse(row(one, 0)).success, false);
  assert.equal(syncRowSchema.safeParse({ ...row(one, 1), senses: -1 }).success, false);
  assert.equal(syncRowSchema.safeParse({ ...row(one, 1), senses: 0 }).success, true);
  const bad = { deviceId: one, readerId: "reader-1", rows: [row(one, 0)], since: null };
  assert.equal(syncRequestSchema.safeParse(bad).success, false);
});

test("a cursor whose local id passes int4 is no cursor, before any SQL", () => {
  const one = randomUUID();
  const at = "2026-10-16T01:02:03.123456Z";
  assert.deepEqual(decodeCursor(`${at}|${one}|2147483647`), { receivedAt: at, deviceId: one, localId: 2_147_483_647 });
  assert.equal(decodeCursor(`${at}|${one}|2147483648`), null);
});
