import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

/**
 * Claims one of today's `cap` model calls before the model is ever reached —
 * never after, so a crash mid-call still spends its claim. The bump is
 * conditional: a call refused at the cap leaves the counter where it was, and
 * two racing claims for the last call cannot both win, because the `where`
 * re-reads the row each one locked.
 */
export async function claimDailyCall(cap: number): Promise<boolean> {
  const rows = await db.execute<{ calls: number }>(sql`
    insert into reading.model_spend as ms (day, calls)
    values (current_date, 1)
    on conflict (day) do update set calls = ms.calls + 1
    where ms.calls < ${cap}
    returning ms.calls
  `);
  return rows.length > 0;
}
