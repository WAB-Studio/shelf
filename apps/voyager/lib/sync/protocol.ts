import { z } from "zod";

// The wire format of the account copy (RL-22). The client driver and the
// route handler both import this file, so the shape a `fetch` sends is
// exactly the shape the handler parses — one schema, not two hand-kept in
// sync (the pattern is lib/translate/types.ts's `translateRequestSchema`).

// ~155 KB per request at ~310 bytes/row typical (424 B/row worst case admits
// 212 KB), up from 289 B/row measured before `translation`. The network's
// answer (`definition` and two examples, 500 characters each) adds up to
// 1.5 KB a row: 500 such rows serialise under 1 MB, still under the 4 MB the
// route admits, so splitting the batch would only double the requests.
export const SYNC_BATCH = 500;

// Rows one reader may send in a UTC day, across every device. Bounds what a
// signed-in caller can write into the shared database.
export const SYNC_DAILY_ROW_CAP = 20_000;

// `integer` and `smallint` columns: a number past them is a bad request, not a 500.
const MAX_INT4 = 2_147_483_647;
const MAX_INT2 = 32_767;

// Largest epoch-ms a JavaScript `Date` holds; past it `toISOString` throws.
const MAX_EPOCH_MS = 8_640_000_000_000_000;

// One row of the reader's log, as it travels off the device that wrote it.
// `deviceId` + `localId` is the row's identity: copying it twice never
// duplicates it, on the way up or on the way down (RL-24).
export const syncRowSchema = z.object({
  deviceId: z.uuid(),
  localId: z.int().positive().max(MAX_INT4),
  at: z.int().min(0).max(MAX_EPOCH_MS), // epoch ms, the device's own clock
  text: z.string().min(1).max(500),
  normalised: z.string().min(1).max(500),
  kind: z.enum(["word", "phrase"]),
  outcome: z.enum(["exact", "inflected", "miss", "translated", "untranslated", "unlisted"]),
  headword: z.string().max(500).nullable(),
  rule: z.string().max(100).nullable(),
  senses: z.int().min(0).max(MAX_INT4),
  translation: z.string().max(120).nullable(),
  dictionaryReady: z.boolean(),
  origin: z.enum(["device", "network"]).nullable(),
  recordSchema: z.int().positive().max(MAX_INT2),
  // The network's answer travels in the copy (RL-62). Optional on the way up:
  // a client installed before this field existed uploads without it, and the
  // row is stored with null. `syncResponseSchema` makes them required.
  definition: z.string().max(500).nullable().optional(),
  exampleEn: z.string().max(500).nullable().optional(),
  exampleEs: z.string().max(500).nullable().optional(),
});

// What a device sends: its own rows since the last upload, and the cursor of
// what it last pulled. The two cursors are never the same value: the upload
// cursor tracks this device's own log, the download cursor tracks the
// account's `received_at` — a device's own clock never orders the other one.
//
// `since`/`cursor` are opaque strings here, not `z.iso.datetime()`: a single upload
// is one INSERT, so its rows share `received_at` to the microsecond, and a
// scalar timestamp cursor either repeats or drops the rest of that group at a
// page boundary. The route that mints and reads this string is the only file
// that knows it also carries the tied row's `(deviceId, localId)`; it treats a
// string of any other shape as no cursor, never as a bad request.
//
// `deviceId` is top-level, not read off `rows[0]`: a pull-only round sends an
// empty `rows`, and the device still has to be nameable there — a reader who
// only ever downloads must still seal its own row in `reading.devices`
// (module 31, RL-25). Always present, never conditional on `rows` being
// empty: one shape for every round keeps the route's own read one line, not
// two paths that can drift apart.
//
// Every row of one batch is one device's: the route checks retirement, seals and
// excludes by `rows[0]`'s device, so a row of another device would ride past all
// three (a retired one's row then fails the insert policy, a 500).
export const syncRequestSchema = z.object({
  deviceId: z.uuid(),
  rows: z
    .array(syncRowSchema)
    .max(SYNC_BATCH)
    .refine((rows) => rows.every((row) => row.deviceId === rows[0].deviceId), { message: "one device per batch" }),
  since: z.string().min(1).nullable(),
});

// What the server answers: how many of the uploaded rows it accepted, the
// rows other devices copied since `since`, and the cursor to send back next
// time. Each row's own `receivedAt` is the server's clock, stamped once per
// row on arrival; `cursor` folds the last row's `receivedAt` together with its
// `(deviceId, localId)` so a tied group never repeats or drops at the page
// boundary (RL-24).
export const syncResponseSchema = z.object({
  accepted: z.int(),
  rows: z.array(
    syncRowSchema.extend({
      definition: z.string().max(500).nullable(),
      exampleEn: z.string().max(500).nullable(),
      exampleEs: z.string().max(500).nullable(),
      receivedAt: z.iso.datetime(),
    }),
  ),
  cursor: z.string().min(1).nullable(),
});

// ---- the cursor ----

// The tuple a cursor names: the last downloaded row's own clock plus the
// `(deviceId, localId)` that makes it unique. `received_at` alone repeats
// across an entire upload batch (one INSERT stamps every row with the same
// `now()`), so a scalar cursor either replays or drops whatever else shares
// that instant at a page boundary.
export type Cursor = { receivedAt: string; deviceId: string; localId: number };

// Opaque to the driver: it stores and echoes the string and never reads what is
// inside. "|" never appears in an ISO timestamp or a UUID, so a plain split
// is enough.
export function encodeCursor(cursor: Cursor): string {
  return `${cursor.receivedAt}|${cursor.deviceId}|${cursor.localId}`;
}

// Every shape Postgres will cast, and no other: the casts below throw on
// anything else, and a thrown cast is a 500 the client retries forever. A
// cursor this route cannot parse is treated as none — a full re-download,
// harmless because the client's merge is idempotent on `[device, deviceSeq]`.
const CURSOR_AT =
  /^(?!0000)\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?Z$/;
const CURSOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_LOCAL_ID = /^[1-9]\d{0,9}$/;

export function decodeCursor(raw: string): Cursor | null {
  const parts = raw.split("|");
  if (parts.length !== 3) return null;
  const [receivedAt, deviceId, localIdText] = parts;
  if (!CURSOR_AT.test(receivedAt) || !CURSOR_UUID.test(deviceId) || !CURSOR_LOCAL_ID.test(localIdText)) return null;
  // 31 February passes the pattern and not the calendar.
  if (new Date(receivedAt).toISOString().slice(0, 10) !== receivedAt.slice(0, 10)) return null;
  const localId = Number(localIdText);
  if (localId > MAX_INT4) return null;
  return { receivedAt, deviceId, localId };
}

export type SyncRow = z.infer<typeof syncRowSchema>;
export type SyncResponse = z.infer<typeof syncResponseSchema>;
