import "server-only";

import { createHmac } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { env } from "@/lib/env";
import { callerAddress } from "@/lib/oauth/throttle";
import { todayInZone } from "@/lib/zone";

export type SignInClaimed = { day: string; keys: Buffer[] };

export type SignInClaim = { status: "ok"; claimed: SignInClaimed } | { status: "capped" } | { status: "noKey" };

// Only a salted digest is stored, never the address or the IP.
const keyOf = (salt: string, value: string): Buffer => createHmac("sha256", salt).update(value).digest();

// One statement; a refused claim leaves the count where it was.
async function claim(key: Buffer, day: string, cap: number): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(sql`select goals.sign_in_claim(${key}, ${day}::date, ${cap}) as ok`);

  return rows[0].ok;
}

/**
 * RP-138's two daily caps on sign-in codes: the caller first, then the address. The address is
 * claimed only once the caller passed, so a refused caller spends nothing of the address's.
 * No salt is `noKey`: the action stays open. The day is Bogotá's, passed in, never `current_date`.
 */
export async function claimSignInLink(headers: { get(name: string): string | null }, address: string): Promise<SignInClaim> {
  const salt = env.CLIENT_KEY_SALT;
  if (!salt) return { status: "noKey" };

  const day = todayInZone();
  const caller = keyOf(salt, `signin:${callerAddress({ headers })}`);
  if (!(await claim(caller, day, env.SIGN_IN_LINK_DAILY_CLIENT_CAP))) return { status: "capped" };

  const recipient = keyOf(salt, `signin-to:${address.toLowerCase()}`);
  if (!(await claim(recipient, day, env.SIGN_IN_LINK_DAILY_ADDRESS_CAP))) return { status: "capped" };

  return { status: "ok", claimed: { day, keys: [caller, recipient] } };
}

// Gives back what `claimSignInLink` counted when Auth refused the send; touches only that day.
export async function releaseSignInLink({ day, keys }: SignInClaimed): Promise<void> {
  if (keys.length === 0) return;
  const list = sql.join(keys.map((key) => sql`${key}`), sql`, `);
  await db.execute(sql`select goals.sign_in_release(array[${list}]::bytea[], ${day}::date)`);
}
