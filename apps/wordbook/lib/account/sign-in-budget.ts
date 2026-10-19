import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { env } from "@/lib/env";
import { claimClientCall, scopedClientKey } from "@/lib/word/client-budget";
import { logDark } from "@/lib/word/dark";
import { clientKeyFromAddress, scopeClientKey } from "@/lib/word/client-key";

/**
 * RL-22 and RL-75's three daily ceilings on sign-in links, all in
 * `reading.client_spend` under the salt every client cap shares: the
 * caller's address, then the address paired with that caller (case-folded),
 * then the address alone at a higher ceiling. Each is claimed only once the
 * one before passed, so a stranger exhausts their own pair and never the
 * owner's, and a caller refused earlier never spends a later one. `noKey` (no salt, or no caller address) keeps the action open:
 * an unset variable must not lock every reader out. `keys` lists what an
 * accepted claim spent, for `releaseSignInLink`.
 */
export async function claimSignInLink(
  headers: Headers,
  address: string,
): Promise<{ status: "ok"; keys: string[] } | { status: "rateLimited" } | { status: "noKey" }> {
  const salt = env.CLIENT_KEY_SALT;
  const caller = scopedClientKey("signin", headers);
  if (!salt || !caller) {
    logDark("signin", "no-caller");
    return { status: "noKey" };
  }

  if (!(await claimClientCall(caller, env.SIGN_IN_LINK_DAILY_CLIENT_CAP))) return { status: "rateLimited" };

  const pair = scopeClientKey("signin-pair", clientKeyFromAddress(`${address.toLowerCase()}|${caller}`, salt))!;
  if (!(await claimClientCall(pair, env.SIGN_IN_LINK_DAILY_ADDRESS_CAP))) return { status: "rateLimited" };

  const recipient = scopeClientKey("signin-to", clientKeyFromAddress(address.toLowerCase(), salt))!;
  if (!(await claimClientCall(recipient, env.SIGN_IN_LINK_DAILY_ADDRESS_CEILING))) return { status: "rateLimited" };

  return { status: "ok", keys: [caller, pair, recipient] };
}

/**
 * Gives back what `claimSignInLink` spent when Auth refused the send, so a
 * refused send leaves all three ceilings where they were. Floors at zero.
 */
export async function releaseSignInLink(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.execute(sql`
    update reading.client_spend
    set calls = calls - 1
    where day = current_date and client in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)}) and calls > 0
  `);
}
