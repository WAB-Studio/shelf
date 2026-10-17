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

export type SignInClaimed = { day: string; keys: string[] };

export type SignInClaim =
  | { status: "ok"; claimed: SignInClaimed }
  | { status: "rateLimited" }
  | { status: "noKey" };

/**
 * RF-143's two daily caps on sign-in links: the caller first, then the recipient. The second
 * is claimed only once the first passed, so a caller refused at their own cap spends nothing
 * of the address's. `noKey` (no salt, or no caller) leaves the decision to the action.
 * `claimed` lists the keys counted, in claim order, for `releaseSignInLink`.
 */
export async function claimSignInLink(headers: Headers, address: string): Promise<SignInClaim> {
  const salt = env.CLIENT_KEY_SALT;
  const caller = salt ? callerKey(headers, salt) : null;
  if (!salt || !caller) {
    console.warn("sign-in claims: no key", { reason: salt ? "no-caller" : "no-salt" });
    return { status: "noKey" };
  }

  // The day is passed in, never `current_date`, which follows the session's zone.
  const day = todayInBogota();
  if (!(await claim(caller, day, env.SIGN_IN_LINK_DAILY_CLIENT_CAP))) return { status: "rateLimited" };
  const recipient = addressKey(address, salt);
  if (!(await claim(recipient, day, env.SIGN_IN_LINK_DAILY_ADDRESS_CAP))) {
    return { status: "rateLimited" };
  }
  return { status: "ok", claimed: { day, keys: [caller, recipient] } };
}

/**
 * Hands back what `claimSignInLink` counted when Auth refused the send. One statement for
 * every key: a row above one is decremented, a row at one is deleted (the CHECK allows no
 * zero), and no other day or key is touched.
 */
export async function releaseSignInLink({ day, keys }: SignInClaimed): Promise<void> {
  if (keys.length === 0) return;
  const list = sql.join(keys.map((k) => sql`${k}`), sql`, `);
  await db.execute(sql`
    with dropped as (
      delete from finances.sign_in_claims
      where day = ${day} and client_key in (${list}) and count = 1
      returning 1
    )
    update finances.sign_in_claims set count = count - 1
    where day = ${day} and client_key in (${list}) and count > 1`);
}
