import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { env } from "@/lib/env";
import { claimClientCall, scopedClientKey } from "@/lib/word/client-budget";
import { logDark } from "@/lib/word/dark";
import { clientKeyFromAddress, scopeClientKey } from "@/lib/word/client-key";

/**
 * RL-22's two daily ceilings on sign-in links, both in `reading.client_spend`
 * under the salt every client cap shares: the caller's address first, then
 * the address the link goes to, case-folded. The second is claimed only once
 * the first passed, so a caller refused at their own cap never spends an
 * address's. `noKey` (no salt, or no caller address) keeps the action open:
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

  const recipient = scopeClientKey("signin-to", clientKeyFromAddress(address.toLowerCase(), salt))!;
  if (!(await claimClientCall(recipient, env.SIGN_IN_LINK_DAILY_ADDRESS_CAP))) return { status: "rateLimited" };

  return { status: "ok", keys: [caller, recipient] };
}

/**
 * Gives back what `claimSignInLink` spent when Auth refused the send, so a
 * refused send leaves both ceilings where they were. Floors at zero.
 */
export async function releaseSignInLink(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.execute(sql`
    update reading.client_spend
    set calls = calls - 1
    where day = current_date and client in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)}) and calls > 0
  `);
}
