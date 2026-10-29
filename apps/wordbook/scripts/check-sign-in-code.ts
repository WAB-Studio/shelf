/**
 * RL-73 on the local stack (`scripts/supabase-local.sh exec`): the code a real
 * sign-in mail carries puts a session cookie in this device's jar through the
 * real `verifySignInCode`, once, and a second use of it is refused.
 *
 * - One confirmed `harness-code-<uuid>@example.invalid`, created through the
 *   admin API (service-role key from the Supabase CLI, as `check-allow-email.ts`
 *   takes it), registered under this run and deleted by exact address on the way
 *   in and the way out.
 * - The mail is asked for with `signInWithOtp` here, on a PKCE client as
 *   `@supabase/ssr` sends; nothing is typed into `/cuenta`, and mailpit (:44324)
 *   is the only inbox it reaches.
 * - `server-only` and `next/headers` are doubled through `module.registerHooks`
 *   (never `Module._load`, which misses `await import`): `cookies()` is this
 *   script's jar, and the double counts its calls to prove it is the one reached.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { resolve } from "node:path";

import { assertSuiteDatabase, closeRun, openRun } from "@repo/harness-registry";
import postgres from "postgres";

assertSuiteDatabase();

const MAILBOX = "http://127.0.0.1:44324";
const root = resolve(import.meta.dirname, "../../..");

const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(apiUrl)) {
  throw new Error(`check-sign-in-code: ${apiUrl || "no API url"} is not the local stack; run through scripts/supabase-local.sh exec`);
}
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

function localServiceRoleKey(): string {
  const out = execFileSync("npx", ["--yes", "supabase@2.119.0", "status", "-o", "env"], { cwd: root, encoding: "utf8" });
  const key = /^SERVICE_ROLE_KEY="(.*)"$/m.exec(out)?.[1];
  if (!key) throw new Error("check-sign-in-code: the local stack gave no service-role key");
  return key;
}
const SERVICE_KEY = localServiceRoleKey();

type Cookie = { name: string; value: string };
const jar = new Map<string, string>();
let cookiesReached = 0;

const double = {
  cookies: async () => {
    cookiesReached += 1;
    return {
      getAll: (): Cookie[] => [...jar].map(([name, value]) => ({ name, value })),
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string | Cookie, value?: string) => {
        if (typeof name === "object") jar.set(name.name, name.value);
        else if (value === "") jar.delete(name);
        else jar.set(name, value ?? "");
      },
      delete: (name: string) => jar.delete(name),
      has: (name: string) => jar.has(name),
    };
  },
  headers: async () => new Headers({ "x-forwarded-for": "198.51.100.73" }),
};
(globalThis as unknown as { __codeDouble: typeof double }).__codeDouble = double;

const DOUBLES: Record<string, string> = {
  "server-only": "export {};",
  "next/headers":
    "export const cookies = () => globalThis.__codeDouble.cookies();" +
    "export const headers = () => globalThis.__codeDouble.headers();",
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

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });

let failed = false;
let n = 0;
function assert(name: string, ok: boolean, detail: string): void {
  n += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  C${n}. ${name} — ${detail}`);
  if (!ok) failed = true;
}

const lastSignIn = async (email: string) =>
  (await sql<{ at: Date | null }[]>`select last_sign_in_at as at from auth.users where email = ${email}`)[0]?.at ?? null;

async function forget(email: string): Promise<void> {
  for (const { id } of await sql<{ id: string }[]>`select id from auth.users where email = ${email}`) {
    await sql`delete from harness.identities where user_id = ${id}`;
    await sql`delete from auth.users where id = ${id}`;
  }
}

type MailSummary = { ID: string; Subject: string };
async function mailsTo(email: string): Promise<MailSummary[]> {
  const found = await (await fetch(`${MAILBOX}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
  return found.messages ?? [];
}

// Polls the inbox until the mail lands, bounded by a deadline, never a fixed wait.
async function mailedCode(email: string): Promise<{ code: string; ids: string[] }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const mails = await mailsTo(email);
    if (mails.length > 0) {
      const message = await (await fetch(`${MAILBOX}/api/v1/message/${mails[0].ID}`)).json();
      // The board's text part puts the code alone on its line.
      const code = /^\s*(\d{6})\s*$/m.exec(String(message.Text ?? ""))?.[1] ?? /(?<!\d)(\d{6})(?!\d)/.exec(mails[0].Subject)?.[1];
      if (!code) throw new Error(`check-sign-in-code: the mail to ${email} carries no six-digit code`);
      return { code, ids: mails.map((mail) => mail.ID) };
    }
    await new Promise((settle) => setTimeout(settle, 250));
  }
  throw new Error(`check-sign-in-code: no mail reached ${email} within 20s`);
}

const authCookies = () => [...jar].filter(([name, value]) => /^sb-.+-auth-token(\.\d+)?$/.test(name) && value !== "");

async function main() {
  const runId = await openRun("rls", sql);
  const email = `harness-code-${randomUUID()}@example.invalid`;
  const mailIds: string[] = [];
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(apiUrl, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    await forget(email);
    const made = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (made.error) throw made.error;
    await sql`
      insert into harness.identities (user_id, run_id, email, disposition)
      values (${made.data.user.id}, ${runId}, ${email}, 'ephemeral') on conflict do nothing`;

    const before = await lastSignIn(email);

    // A device of its own that asks for the mail, as the browser does, with PKCE.
    const memory = new Map<string, string>();
    const device = createClient(apiUrl, publishableKey, {
      auth: {
        flowType: "pkce",
        persistSession: true,
        autoRefreshToken: false,
        storage: {
          getItem: (key) => memory.get(key) ?? null,
          setItem: (key, value) => void memory.set(key, value),
          removeItem: (key) => void memory.delete(key),
        },
      },
    });
    const sent = await device.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    if (sent.error) throw sent.error;
    const { code, ids } = await mailedCode(email);
    mailIds.push(...ids);

    const { verifySignInCode } = await import("../app/actions/account");

    const first = await verifySignInCode(email, code);
    assert("the mailed code lets the reader in", JSON.stringify(first) === JSON.stringify({ ok: true }), `result=${JSON.stringify(first)}`);
    assert("the action reached this script's cookie jar, not a real one", cookiesReached > 0, `cookies() calls=${cookiesReached}`);
    const tokens = authCookies();
    assert(
      "the device's jar holds an sb-…-auth-token cookie after the code",
      tokens.length > 0,
      `jar=${[...jar.keys()].join(",") || "(empty)"}`,
    );

    const after = await lastSignIn(email);
    assert(
      "auth.users.last_sign_in_at moved: Auth itself saw the sign-in",
      after !== null && (before === null || after.getTime() > before.getTime()),
      `before=${before?.toISOString() ?? "null"} after=${after?.toISOString() ?? "null"}`,
    );

    const second = await verifySignInCode(email, code);
    assert(
      "the same code used a second time is refused as codeInvalid",
      JSON.stringify(second) === JSON.stringify({ ok: false, error: "codeInvalid" }),
      `result=${JSON.stringify(second)}`,
    );
  } finally {
    await forget(email);
    for (const id of mailIds) await fetch(`${MAILBOX}/api/v1/messages`, { method: "DELETE", body: JSON.stringify({ IDs: [id] }) });
    const left = await sql`select 1 from auth.users where email = ${email}`;
    if (left.length > 0) {
      console.log(`FAIL  cleanup: ${email} is still in auth.users`);
      failed = true;
    }
    await closeRun(sql);
    await sql.end();
  }

  console.log(`\nREPORT  ${n} asserted, ${failed ? "FAILED" : "all passed"}`);
  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
