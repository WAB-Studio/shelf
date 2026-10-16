import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { env } from "@/lib/env";
import {
  clientKey as clientKeyWithSalt,
  clientKeyFromHeaders,
  scopeClientKey,
} from "@/lib/word/client-key";

// A budget nobody can charge is a budget that does not exist: with no salt
// configured, every caller reads `null` and the route above answers 204 —
// the same switch `WORD_TEXT_DAILY_CALL_CAP` already is for RL-41/RL-42. The
// address itself is hashed away in the same step and never returned.
//
// Unscoped on purpose: `/api/word/unlisted` and `/api/phrase/notes` share
// this one row per caller, each read against its own ceiling.
export function clientKey(request: Request): string | null {
  return clientKeyWithSalt(request, env.CLIENT_KEY_SALT);
}

export function scopedClientKey(scope: "text" | "translate" | "signin", headers: Headers): string | null {
  return scopeClientKey(scope, clientKeyFromHeaders(headers, env.CLIENT_KEY_SALT));
}

/**
 * The per-caller half of a paid route's budget, on top of `claimDailyCall`'s
 * global one (`lib/word/spend.ts`). Conditional the same way: a caller
 * refused at `cap` leaves their counter where it was.
 */
export async function claimClientCall(client: string, cap: number): Promise<boolean> {
  const rows = await db.execute<{ calls: number }>(sql`
    insert into reading.client_spend as cs (day, client, calls)
    values (current_date, ${client}, 1)
    on conflict (day, client) do update set calls = cs.calls + 1
    where cs.calls < ${cap}
    returning cs.calls
  `);
  return rows.length > 0;
}
