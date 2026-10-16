/**
 * Drives the real `sendSignInLink` (`app/actions/account.ts`) against the
 * local stack's `reading.client_spend`, with three modules swapped at load
 * (`server-only` too, which throws outside Next):
 *
 * - `@repo/supabase-auth` is a double whose client factory counts its call
 *   and throws, so no path here ever reaches `signInWithOtp`. A request that
 *   gets past every cap is seen as one double call and a rejection.
 * - `next/headers` answers the caller's headers the test sets.
 * - `node:dns/promises` answers MX for `example.invalid` and nothing for any
 *   other domain. The deliverability guard itself runs unchanged.
 *
 * Every address is `@example.invalid` or `@nonexistent.invalid`, never typed
 * into `/cuenta`. Every key is hashed with this script's own salt, and every
 * row is deleted on the way in and on the way out.
 */
import { registerHooks } from "node:module";

import { assertSuiteDatabase } from "@repo/harness-registry";
import postgres from "postgres";

import { clientKeyFromAddress, scopeClientKey } from "../lib/word/client-key";

assertSuiteDatabase();

const SALT = "check-sign-in-salt-not-a-reader";
const CLIENT_CAP = 5;
const ADDRESS_CAP = 3;
process.env.CLIENT_KEY_SALT = SALT;
process.env.SIGN_IN_LINK_DAILY_CLIENT_CAP = String(CLIENT_CAP);
process.env.SIGN_IN_LINK_DAILY_ADDRESS_CAP = String(ADDRESS_CAP);

let supabaseCalls = 0;
let currentHeaders = new Headers();

function notFound(): never {
  throw Object.assign(new Error("queryMx ENOTFOUND"), { code: "ENOTFOUND" });
}

// The doubles' bodies live here; the modules the hooks below hand the action
// only forward to them. `registerHooks`, not a `Module._load` patch: the
// action reaches Supabase and `next/headers` through `await import`, which
// never passes through `_load` — measured, the real client loaded.
const double = {
  createSupabaseServerClient: () => {
    supabaseCalls += 1;
    throw new Error("check-sign-in-budget: the Supabase double was reached");
  },
  headers: async () => currentHeaders,
  resolveMx: async (domain: string) =>
    domain.toLowerCase() === "example.invalid" ? [{ exchange: "mx.example.invalid", priority: 10 }] : notFound(),
  resolveNone: async () => notFound(),
};
(globalThis as unknown as { __signInDouble: typeof double }).__signInDouble = double;

const DOUBLES: Record<string, string> = {
  "server-only": "export {};",
  "@repo/supabase-auth":
    "export const createSupabaseServerClient = (...a) => globalThis.__signInDouble.createSupabaseServerClient(...a);",
  "next/headers": "export const headers = () => globalThis.__signInDouble.headers();",
  "node:dns/promises":
    "export const resolveMx = (d) => globalThis.__signInDouble.resolveMx(d);" +
    "export const resolve4 = () => globalThis.__signInDouble.resolveNone();" +
    "export const resolve6 = () => globalThis.__signInDouble.resolveNone();",
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in DOUBLES) return { url: `double:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("double:")) return { format: "module", source: DOUBLES[url.slice("double:".length)], shortCircuit: true };
    return nextLoad(url, context);
  },
});

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

let counter = 0;
let failed = false;
let passes = 0;
let failures = 0;

function assert(name: string, ok: boolean, detail: string): void {
  counter += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  L${counter}. ${name} — ${detail}`);
  if (ok) passes += 1;
  else {
    failures += 1;
    failed = true;
  }
}

function callerKey(ip: string): string {
  return scopeClientKey("signin", clientKeyFromAddress(ip, SALT))!;
}

function addressKey(address: string): string {
  return scopeClientKey("signin-to", clientKeyFromAddress(address.toLowerCase(), SALT))!;
}

const IPS = Array.from({ length: 14 }, (_, i) => `198.51.100.${60 + i}`);
const ADDRESSES = [
  "first@example.invalid",
  ...Array.from({ length: 6 }, (_, i) => `ip-cap-${i}@example.invalid`),
  "shared@example.invalid",
  "a@example.invalid",
  "x@nonexistent.invalid",
  ...Array.from({ length: 8 }, (_, i) => `race-${i}@example.invalid`),
];
const KEYS = [...IPS.map(callerKey), ...ADDRESSES.map(addressKey)];

async function calls(client: string): Promise<number | null> {
  const [row] = await sql<{ calls: number }[]>`
    select calls from reading.client_spend where day = current_date and client = ${client}`;
  return row?.calls ?? null;
}

type Outcome = "reachedSupabase" | string;

async function main() {
  const { sendSignInLink } = await import("../app/actions/account");

  // One request from `ip` for `address`: the action's own result, or
  // `reachedSupabase` when it got past every cap and hit the double.
  async function send(ip: string, address: string): Promise<Outcome> {
    currentHeaders = new Headers({ "x-forwarded-for": ip });
    try {
      const result = await sendSignInLink(address);
      return result.ok ? "ok" : result.error;
    } catch (error) {
      if (error instanceof Error && error.message.includes("Supabase double")) return "reachedSupabase";
      throw error;
    }
  }

  const clear = () => sql`delete from reading.client_spend where day = current_date and client = any(${KEYS})`;

  try {
    await clear();

    // Under both caps: the request goes on to Supabase, once, never retried.
    const first = await send(IPS[0], "first@example.invalid");
    assert(
      "under both caps the request reaches Supabase's double exactly once",
      first === "reachedSupabase" && supabaseCalls === 1,
      `outcome=${first} supabaseCalls=${supabaseCalls}`,
    );
    assert(
      "that request spent one from the caller and one from the address",
      (await calls(callerKey(IPS[0]))) === 1 && (await calls(addressKey("first@example.invalid"))) === 1,
      `caller=${await calls(callerKey(IPS[0]))} address=${await calls(addressKey("first@example.invalid"))}`,
    );

    // Per caller: five links to five addresses, then a sixth is refused.
    supabaseCalls = 0;
    const ipCap: Outcome[] = [];
    for (let i = 0; i < CLIENT_CAP + 1; i += 1) ipCap.push(await send(IPS[1], `ip-cap-${i}@example.invalid`));
    assert(
      `the ${CLIENT_CAP + 1}th link from one caller at SIGN_IN_LINK_DAILY_CLIENT_CAP=${CLIENT_CAP} is rateLimited before Supabase`,
      ipCap.slice(0, CLIENT_CAP).every((o) => o === "reachedSupabase") &&
        ipCap[CLIENT_CAP] === "rateLimited" &&
        supabaseCalls === CLIENT_CAP,
      `outcomes=${ipCap.join()} supabaseCalls=${supabaseCalls}`,
    );
    const refusedAddress = await calls(addressKey(`ip-cap-${CLIENT_CAP}@example.invalid`));
    assert(
      "the address of a request the caller cap refused spent nothing",
      refusedAddress === null,
      `signin-to=${refusedAddress}`,
    );

    // Per address: three links from three callers, then a fourth caller is refused.
    supabaseCalls = 0;
    const addressCap: Outcome[] = [];
    for (let i = 0; i < ADDRESS_CAP + 1; i += 1) addressCap.push(await send(IPS[2 + i], "shared@example.invalid"));
    assert(
      `the ${ADDRESS_CAP + 1}th link to one address from distinct callers at SIGN_IN_LINK_DAILY_ADDRESS_CAP=${ADDRESS_CAP} is rateLimited`,
      addressCap.slice(0, ADDRESS_CAP).every((o) => o === "reachedSupabase") &&
        addressCap[ADDRESS_CAP] === "rateLimited" &&
        supabaseCalls === ADDRESS_CAP,
      `outcomes=${addressCap.join()} supabaseCalls=${supabaseCalls}`,
    );

    // Case: `A@` and `a@` are one address.
    supabaseCalls = 0;
    const cased: Outcome[] = [];
    for (let i = 0; i < ADDRESS_CAP; i += 1) cased.push(await send(IPS[6 + i], "A@example.invalid"));
    cased.push(await send(IPS[9], "a@example.invalid"));
    assert(
      "A@example.invalid and a@example.invalid count against one address cap",
      cased.slice(0, ADDRESS_CAP).every((o) => o === "reachedSupabase") &&
        cased[ADDRESS_CAP] === "rateLimited" &&
        supabaseCalls === ADDRESS_CAP,
      `outcomes=${cased.join()} supabaseCalls=${supabaseCalls}`,
    );

    // A dead domain is refused by the guard, before any cap is spent.
    supabaseCalls = 0;
    const dead = await send(IPS[10], "x@nonexistent.invalid");
    const deadCaller = await calls(callerKey(IPS[10]));
    const deadAddress = await calls(addressKey("x@nonexistent.invalid"));
    assert(
      "an undeliverable domain answers domainUndeliverable and spends neither counter",
      dead === "domainUndeliverable" && deadCaller === null && deadAddress === null && supabaseCalls === 0,
      `outcome=${dead} caller=${deadCaller} address=${deadAddress} supabaseCalls=${supabaseCalls}`,
    );

    // No caller address: the action stays open, as it was before any cap.
    supabaseCalls = 0;
    currentHeaders = new Headers();
    let noKey: Outcome;
    try {
      const result = await sendSignInLink("ip-cap-0@example.invalid");
      noKey = result.ok ? "ok" : result.error;
    } catch {
      noKey = "reachedSupabase";
    }
    assert(
      "a caller with no address to key is not capped",
      noKey === "reachedSupabase" && supabaseCalls === 1,
      `outcome=${noKey} supabaseCalls=${supabaseCalls}`,
    );

    // Parallel: eight links at once from one caller, to eight addresses.
    supabaseCalls = 0;
    const race = await Promise.all(
      Array.from({ length: 8 }, (_, i) => send(IPS[11], `race-${i}@example.invalid`)),
    );
    const raceLimited = race.filter((o) => o === "rateLimited").length;
    assert(
      `eight parallel links from one caller: exactly ${CLIENT_CAP} reach Supabase, the counter stops at the cap`,
      supabaseCalls === CLIENT_CAP && raceLimited === 8 - CLIENT_CAP && (await calls(callerKey(IPS[11]))) === CLIENT_CAP,
      `supabaseCalls=${supabaseCalls} rateLimited=${raceLimited} caller=${await calls(callerKey(IPS[11]))}`,
    );
  } finally {
    const deleted = await clear();
    console.log(`Cleanup: deleted ${deleted.count} client_spend row(s)`);
    await sql.end();
  }

  console.log("");
  console.log(`REPORT  ${passes} pass, ${failures} fail`);
  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
