import "server-only";

import { env } from "@/lib/env";
import { claimClientCall, scopedClientKey } from "@/lib/word/client-budget";
import { clientKeyFromAddress, scopeClientKey } from "@/lib/word/client-key";

/**
 * RL-22's two daily ceilings on sign-in links, both in `reading.client_spend`
 * under the salt every client cap shares: the caller's address first, then
 * the address the link goes to, case-folded. The second is claimed only once
 * the first passed, so a caller refused at their own cap never spends an
 * address's. `noKey` (no salt, or no caller address) keeps the action open:
 * an unset variable must not lock every reader out.
 */
export async function claimSignInLink(
  headers: Headers,
  address: string,
): Promise<"ok" | "rateLimited" | "noKey"> {
  const salt = env.CLIENT_KEY_SALT;
  const caller = scopedClientKey("signin", headers);
  if (!salt || !caller) return "noKey";

  if (!(await claimClientCall(caller, env.SIGN_IN_LINK_DAILY_CLIENT_CAP))) return "rateLimited";

  const recipient = scopeClientKey("signin-to", clientKeyFromAddress(address.toLowerCase(), salt))!;
  if (!(await claimClientCall(recipient, env.SIGN_IN_LINK_DAILY_ADDRESS_CAP))) return "rateLimited";

  return "ok";
}
