import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { writeReceipts } from "@/db/schema";
import type { Transaction } from "@/lib/session";

/**
 * The answer an act gave to `requestId` for this person, or null when the id
 * was never answered (RP-56). Filters on the person as well as the id: two
 * people may carry the same id, and a caller running as the owner role sees
 * every row.
 */
export async function readReceipt(
  tx: Transaction,
  personId: string,
  requestId: string,
): Promise<unknown> {
  const [row] = await tx
    .select({ answer: writeReceipts.answer })
    .from(writeReceipts)
    .where(and(eq(writeReceipts.userId, personId), eq(writeReceipts.requestId, requestId)));

  return row ? row.answer : null;
}

/**
 * Records what `act` answered to `requestId`, inside the caller's transaction
 * so the receipt lands or rolls back with the write it describes. A second
 * receipt for the same person and id fails with 23505.
 *
 * Raw SQL, not the insert builder: the builder names `made_at`, which no grant
 * covers. The prune runs in the same statement and reaches only the settled
 * person's receipts (`goals.prune_write_receipts`, migration 0029).
 */
export async function writeReceipt(
  tx: Transaction,
  personId: string,
  requestId: string,
  act: string,
  answer: object,
): Promise<void> {
  await tx.execute(sql`
    insert into goals.write_receipts (user_id, request_id, act, answer)
    select ${personId}::uuid, ${requestId}::uuid, ${act}, ${JSON.stringify(answer)}::jsonb
      from goals.prune_write_receipts()`);
}
