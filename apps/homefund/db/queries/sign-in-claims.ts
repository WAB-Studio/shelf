import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { addressKey, callerKey } from "@/lib/auth/client-key";
import { todayInBogota } from "@/lib/dates";
import { env } from "@/lib/env";

/**
 * Counts one link against `key` for `day` in one statement. The `where` on the conflict
 * leaves a capped row untouched and returns nothing, so a refusal never moves the count.
 */
async function claim(key: string, day: string, cap: number): Promise<boolean> {
  const rows = await db.execute<{ count: number }>(sql`
    insert into finances.sign_in_claims (client_key, day, count)
    values (${key}, ${day}, 1)
    on conflict (client_key, day) do update set count = sign_in_claims.count + 1
      where sign_in_claims.count < ${cap}
    returning count`);
  return rows.length > 0;
}

/**
 * RF-143's two daily caps on sign-in links: the caller first, then the recipient. The second
 * is claimed only once the first passed, so a caller refused at their own cap spends nothing
 * of the address's. `noKey` (no salt, or no caller) leaves the decision to the action.
 */
export async function claimSignInLink(
  headers: Headers,
  address: string,
): Promise<"ok" | "rateLimited" | "noKey"> {
  const salt = env.CLIENT_KEY_SALT;
  const caller = salt ? callerKey(headers, salt) : null;
  if (!salt || !caller) {
    console.warn("sign-in claims: no key", { reason: salt ? "no-caller" : "no-salt" });
    return "noKey";
  }

  // The day is passed in, never `current_date`, which follows the session's zone.
  const day = todayInBogota();
  if (!(await claim(caller, day, env.SIGN_IN_LINK_DAILY_CLIENT_CAP))) return "rateLimited";
  if (!(await claim(addressKey(address, salt), day, env.SIGN_IN_LINK_DAILY_ADDRESS_CAP))) {
    return "rateLimited";
  }
  return "ok";
}
