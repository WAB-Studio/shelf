"use server";

import { resolve4, resolve6, resolveMx } from "node:dns/promises";

import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { z } from "zod";

// `@repo/supabase-auth`, `@/lib/account/sign-in-budget` and `@/lib/auth/allowlist` (through `@/db/client`) load
// `import "server-only"`, and `@/lib/env` throws when its required vars are
// unset — all resolvable only inside Next's own build. A plain Node import
// (Playwright's test runner, driving `isDomainDeliverable` on its own below)
// dies on any of them. Deferred so importing this file to reach that check
// never has to load them.
async function supabaseClient() {
  const [{ createSupabaseServerClient }, { env }] = await Promise.all([
    import("@repo/supabase-auth"),
    import("@/lib/env"),
  ]);
  return createSupabaseServerClient({
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}

const emailSchema = z.email();

export type SendSignInLinkResult =
  | { ok: true }
  | { ok: false; error: "emailInvalid" | "domainUndeliverable" | "sendFailed" | "rateLimited" | "capped" | "notInvited" };

// RFC 5321 §5.1: no MX falls back to the domain's own address record
// (implicit MX). RFC 7505: a domain that takes no mail at all publishes
// exactly one MX, ".", rather than none — the shape `example.com` actually
// returns. Kept narrow on purpose: anything the DNS lookup itself cannot
// answer cleanly (timeout, SERVFAIL, no network) has to read as
// deliverable, never as a reason to lock a reader out of their own account.
const DNS_TIMEOUT_MS = 2_500;

type MxRecord = { exchange: string; priority: number };
type DnsResolvers = {
  resolveMx: (domain: string) => Promise<MxRecord[]>;
  resolve4: (domain: string) => Promise<string[]>;
  resolve6: (domain: string) => Promise<string[]>;
};

const systemResolvers: DnsResolvers = { resolveMx, resolve4, resolve6 };

function isNullMx(records: MxRecord[]): boolean {
  return records.length === 1 && records[0].priority === 0 && records[0].exchange.replace(/\.$/, "") === "";
}

// "no answer" (no such record) and "the lookup itself broke" need different
// endings: the first still has another record type to try, or is the real
// verdict; the second must never count against the domain.
async function queryOutcome<T>(query: () => Promise<T[]>): Promise<"records" | "none" | "failure"> {
  try {
    const records = await query();
    return records.length > 0 ? "records" : "none";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOTFOUND" || code === "ENODATA" ? "none" : "failure";
  }
}

async function hasAddressRecord(domain: string, resolvers: DnsResolvers): Promise<boolean> {
  const v4 = await queryOutcome(() => resolvers.resolve4(domain));
  if (v4 !== "none") return true; // "records" and "failure" both let the reader through

  const v6 = await queryOutcome(() => resolvers.resolve6(domain));
  return v6 !== "none"; // "records" and "failure" both let the reader through.
}

async function checkDeliverable(domain: string, resolvers: DnsResolvers): Promise<boolean> {
  let mxRecords: MxRecord[] = [];
  try {
    mxRecords = await resolvers.resolveMx(domain);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOTFOUND" && code !== "ENODATA") return true; // the resolver, not the domain, failed
  }

  if (mxRecords.length > 0) return !isNullMx(mxRecords);
  return hasAddressRecord(domain, resolvers);
}

/**
 * Whether `domain` can receive mail at all (RFC 5321 §5.1, RFC 7505). Takes
 * its resolvers as a parameter so a test can hand it ones that throw or
 * hang, rather than depending on a real broken resolver to prove the
 * fail-open path.
 */
export async function isDomainDeliverable(domain: string, resolvers: DnsResolvers = systemResolvers): Promise<boolean> {
  const timedOut = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(true), DNS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([checkDeliverable(domain, resolvers), timedOut]);
  } catch {
    return true; // an unexpected throw is still the resolver's problem, not the reader's
  }
}

/**
 * Asks for the sign-in link (RL-22). No `data` on the call: it would land in
 * `raw_user_meta_data`, which the user can rewrite and which surfaces in the
 * JWT — there is no `app_users` row here for state to live in instead.
 */
export async function sendSignInLink(email: string): Promise<SendSignInLinkResult> {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) return { ok: false, error: "emailInvalid" };

  const domain = parsed.data.slice(parsed.data.lastIndexOf("@") + 1);
  // Before Supabase ever sees the address: a domain that cannot take mail
  // must not get a row in `auth.users` or a send against the project's own
  // quota, both spent whether or not the message can land.
  if (!(await isDomainDeliverable(domain))) return { ok: false, error: "domainUndeliverable" };

  // After the guard, so a dead address never spends a caller's allowance; before
  // Supabase, so a caller over it never spends the project's mail quota.
  const [{ headers }, { claimSignInLink, releaseSignInLink }] = await Promise.all([
    import("next/headers"),
    import("@/lib/account/sign-in-budget"),
  ]);
  const claim = await claimSignInLink(await headers(), parsed.data);
  if (claim.status === "rateLimited") return { ok: false, error: "capped" };
  const spent = claim.status === "ok" ? claim.keys : [];

  // RL-69: after the claim, so probing the list spends the caller's allowance like a send does;
  // before Supabase, so an address off it never gets a row in `auth.users` or an email. A list
  // that cannot be read refuses rather than lets the address through.
  const { isEmailAllowed } = await import("@/lib/auth/allowlist");
  let listed: boolean;
  try {
    listed = await isEmailAllowed(parsed.data);
  } catch (error) {
    console.error("allowed-emails read failed", error);
    return { ok: false, error: "sendFailed" };
  }
  if (!listed) return { ok: false, error: "notInvited" };

  const [supabase, { env }] = await Promise.all([supabaseClient(), import("@/lib/env")]);

  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/confirm`,
    },
  });

  if (error) {
    console.error("sign-in link request failed", error);
    // A send Auth refused spends nothing; a timed-out one may have been delivered, so it keeps its count.
    if (!isAuthRetryableFetchError(error)) await releaseSignInLink(spent);
    // 429 (over_email_send_rate_limit) names the wait, not just the
    // failure to send — every other status keeps the generic copy.
    return { ok: false, error: error.status === 429 ? "rateLimited" : "sendFailed" };
  }

  // Identical whether or not that address already has an account: the answer
  // must not tell a stranger who is registered.
  return { ok: true };
}

export async function signOut(): Promise<void> {
  const supabase = await supabaseClient();

  const { error } = await supabase.auth.signOut();
  // Logged, not surfaced: the session is gone from this browser either way.
  if (error) console.error("sign-out failed", error);

  redirect("/registro");
}

export type VerifySignInCodeResult =
  | { ok: true }
  | { ok: false; error: "emailInvalid" | "codeShape" | "codeInvalid" | "codeTimeout" | "rateLimited" };

// RL-73: shape before Auth; nothing is sent, so no DNS, cap or list. The session
// cookie is set by the server client; the caller refreshes.
export async function verifySignInCode(email: string, code: string): Promise<VerifySignInCodeResult> {
  const parsedEmail = emailSchema.safeParse(email);
  if (!parsedEmail.success) return { ok: false, error: "emailInvalid" };
  const [{ signInCodeSchema }, { verifyCode }] = await Promise.all([
    import("@/lib/account/sign-in-code"),
    import("@/lib/auth/verify-code"),
  ]);
  const parsedCode = signInCodeSchema.safeParse(code);
  if (!parsedCode.success) return { ok: false, error: "codeShape" };
  const supabase = await supabaseClient();
  const result = await verifyCode((params) => supabase.auth.verifyOtp(params), { email: parsedEmail.data, code: parsedCode.data });
  return result.ok ? { ok: true } : { ok: false, error: result.reason };
}
