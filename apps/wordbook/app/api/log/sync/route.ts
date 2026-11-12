import "server-only";

import { json } from "@/lib/http/responses";
import { getReader, withReaderDb } from "@/lib/session";
import { deviceLabel } from "@/lib/sync/device-label";
import { syncRequestSchema, decodeCursor, encodeCursor, type SyncResponse } from "@/lib/sync/protocol";
import { decodeReviewCursor, encodeReviewCursor, type ReviewAnswer } from "@/lib/sync/review-protocol";
import { syncReviewEntries, type ReviewRound } from "@/lib/sync/review-upload";
import { downloadRows, writeUpload, type DownloadedRow } from "@/lib/sync/upload";
import { refuseCrossSiteRequest } from "@/lib/word/same-origin";

function toWireRow(row: DownloadedRow): SyncResponse["rows"][number] {
  return {
    deviceId: row.device_id,
    localId: row.local_id,
    at: new Date(`${row.at}Z`).getTime(),
    text: row.text,
    normalised: row.normalised,
    kind: row.kind,
    outcome: row.outcome,
    headword: row.headword,
    rule: row.rule,
    senses: row.senses,
    translation: row.translation,
    dictionaryReady: row.dictionary_ready,
    origin: row.origin,
    recordSchema: row.record_schema,
    definition: row.definition,
    exampleEn: row.example_en,
    exampleEs: row.example_es,
    receivedAt: `${row.received_at}Z`,
  };
}

// The review's page of this round (RL-93). The cursor is echoed from what was asked when nothing came down, and
// only when it was legible: a garbled one would otherwise come back and be stored again.
function toReviewAnswer(round: ReviewRound, asked: string | null): ReviewAnswer {
  const entries = round.entries.map(({ updated_at: updatedAt, ...entry }) => ({ entry, updatedAt }));
  const last = entries.at(-1);
  const since = asked ? decodeReviewCursor(asked) : null;
  const cursor = last ? encodeReviewCursor({ updatedAt: `${last.updatedAt}Z`, key: last.entry.key }) : since && encodeReviewCursor(since);
  return { accepted: round.accepted, full: round.full, entries: entries.map(({ entry }) => entry), cursor };
}

export async function POST(request: Request): Promise<Response> {
  // Without a session there is no query at all: `getReader` never touches
  // Postgres, so the 401 never opens a connection.
  const reader = await getReader();
  if (!reader) return json({ error: "unauthorized" }, 401);

  const refused = refuseCrossSiteRequest(request);
  if (refused) return refused;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "invalid" }, 400);
  }

  const parsed = syncRequestSchema.safeParse(raw);
  if (!parsed.success) return json({ error: "invalid" }, 400);

  const { rows, since, tombstones, tombstonesSince, review } = parsed.data;

  // A stale tab can hold one reader's sync row while the cookie now speaks for
  // another: nothing is written, and the client drops its identity.
  if (parsed.data.readerId !== reader.id) return json({ error: "reader" }, 409);

  // Nothing ties the top-level `deviceId` to the one on the rows: both are
  // `z.uuid()` and a request may disagree with itself. The rows share one
  // device (the schema refuses a mixed batch), and a batch with rows has
  // always spoken for that device — sealing and excluding any other
  // sends the rows just uploaded straight back down in the same response — so
  // it keeps doing that. The top-level field answers only the empty batch, a
  // download-only round (RL-22) with no row to read a device off.
  const deviceId = rows.length > 0 ? rows[0].deviceId : parsed.data.deviceId;
  const label = deviceLabel(request.headers.get("user-agent"));

  const sinceCursor = since ? decodeCursor(since) : null;
  const marksCursor = tombstonesSince ? decodeCursor(tombstonesSince) : null;
  const reviewSince = review?.since ? decodeReviewCursor(review.since) : null;

  const outcome = await withReaderDb(async (tx) => {
    // Same statement order the contract names: upload, then download.
    const upload = await writeUpload(tx, reader.id, deviceId, label, rows, undefined, tombstones, marksCursor);
    if (upload.status !== "ok") return upload;
    return {
      status: "ok",
      accepted: upload.accepted,
      marks: upload.tombstones,
      downloaded: await downloadRows(tx, sinceCursor, deviceId),
      // One more statement, only when the device sent the review's half; a retired or capped round never reaches it.
      review: review ? await syncReviewEntries(tx, reader.id, review.entries, reviewSince) : null,
    } as const;
  });

  if (outcome.status === "retired") return json({ error: "retired" }, 409);
  if (outcome.status === "quota") return json({ error: "quota" }, 429);

  const wireRows = outcome.downloaded.map(toWireRow);
  const last = wireRows[wireRows.length - 1];
  // Echoes the cursor only when it was legible: a garbled one would otherwise
  // come back and be stored again.
  const cursor = last
    ? encodeCursor({ receivedAt: last.receivedAt, deviceId: last.deviceId, localId: last.localId })
    : sinceCursor && encodeCursor(sinceCursor);

  const lastMark = outcome.marks.at(-1);
  // Each cursor is echoed from its own field alone: the two clocks never stand in for each other.
  const tombstoneCursor = lastMark
    ? encodeCursor({ receivedAt: `${lastMark.deleted_at}Z`, deviceId: lastMark.device_id, localId: lastMark.local_id })
    : marksCursor && encodeCursor(marksCursor);

  const response: SyncResponse = {
    accepted: outcome.accepted,
    rows: wireRows,
    cursor,
    tombstones: outcome.marks.map((mark) => ({ deviceId: mark.device_id, localId: mark.local_id })),
    tombstoneCursor,
    review: outcome.review && toReviewAnswer(outcome.review, review?.since ?? null),
  };
  return json(response, 200);
}
