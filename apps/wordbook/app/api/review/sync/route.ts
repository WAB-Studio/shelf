import "server-only";

import { json } from "@/lib/http/responses";
import { getReader, withReaderDb } from "@/lib/session";
import {
  decodeReviewCursor,
  encodeReviewCursor,
  reviewSyncRequestSchema,
  type ReviewSyncResponse,
} from "@/lib/sync/review-protocol";
import { syncReviewEntries } from "@/lib/sync/review-upload";
import { refuseCrossSiteRequest } from "@/lib/word/same-origin";

// The copy of the review's cards, senses and deletions (RL-93): what the device changed goes up, what the other
// devices changed comes down. Like `/api/log/sync`, only a session the reader opened on purpose is answered, and
// with none there is no query at all. It carries no word's answer text, only the keys the reader already recorded.
export async function POST(request: Request): Promise<Response> {
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

  const parsed = reviewSyncRequestSchema.safeParse(raw);
  if (!parsed.success) return json({ error: "invalid" }, 400);

  // A stale tab can hold one reader's identity while the cookie now speaks for another.
  if (parsed.data.readerId !== reader.id) return json({ error: "reader" }, 409);

  const since = parsed.data.since ? decodeReviewCursor(parsed.data.since) : null;
  const round = await withReaderDb((tx) => syncReviewEntries(tx, reader.id, parsed.data.entries, since));
  if (round.status === "full") return json({ error: "quota" }, 429);

  const entries = round.entries.map(({ updated_at: updatedAt, ...entry }) => ({ entry, updatedAt }));
  const last = entries.at(-1);
  // Echoes the cursor only when it was legible: a garbled one would otherwise come back and be stored again.
  const cursor = last ? encodeReviewCursor({ updatedAt: `${last.updatedAt}Z`, key: last.entry.key }) : since && encodeReviewCursor(since);

  const response: ReviewSyncResponse = { accepted: round.accepted, entries: entries.map(({ entry }) => entry), cursor };
  return json(response, 200);
}
