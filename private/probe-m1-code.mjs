/**
 * M1's probe (contract: private/contrato-m1.md, Done table). Local stack only.
 * Run: scripts/supabase-local.sh exec node private/probe-m1-code.mjs [clause…]
 * Clauses: u1 magic confirmation subject words link. No argument runs them all.
 *
 * Sends the way the apps send: @supabase/ssr's createServerClient (flowType pkce),
 * a cookie jar, `emailRedirectTo` <app>/auth/confirm. Reads the mail from mailpit.
 * Every address is harness-code-<uuid>@example.invalid, deleted by exact address
 * through the admin API, and its mail deleted from mailpit, before exit.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const ROOT = resolve(import.meta.dirname, "..");
const MAILBOX = "http://127.0.0.1:54324";
const REDIRECT = "http://localhost:3101/auth/confirm";

const API = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):54321\/?$/.test(API)) {
  throw new Error(`probe-m1: ${API || "no API url"} is not the local stack; run through scripts/supabase-local.sh exec`);
}
if (!ANON) throw new Error("probe-m1: no publishable key");

const statusEnv = execFileSync("npx", ["--yes", "supabase@2.119.0", "status", "-o", "env"], { cwd: ROOT, encoding: "utf8" });
const SERVICE = /^SERVICE_ROLE_KEY="(.*)"$/m.exec(statusEnv)?.[1];
if (!SERVICE) throw new Error("probe-m1: the local stack gave no service-role key");
const admin = createClient(API, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const wanted = new Set(process.argv.slice(2));
const runs = (clause) => wanted.size === 0 || wanted.has(clause);

let failed = false;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!ok) failed = true;
}

// The server client every app builds, over a jar a test can read.
function ssrClient() {
  const jar = new Map();
  const client = createServerClient(API, ANON, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (set) => {
        for (const { name, value } of set) value ? jar.set(name, value) : jar.delete(name);
      },
    },
  });
  return { client, jar };
}

const created = new Set();
const address = () => {
  const email = `harness-code-${randomUUID()}@example.invalid`;
  created.add(email);
  return email;
};

async function search(email) {
  const res = await fetch(`${MAILBOX}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
  return (await res.json()).messages ?? [];
}

// Polls mailpit until the message arrives or 15 s pass; no fixed wait.
async function mailFor(email) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const [first] = await search(email);
    if (first) return (await fetch(`${MAILBOX}/api/v1/message/${first.ID}`)).json();
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`probe-m1: no mail reached ${email}`);
}

// URLs carry hex hashes whose digit runs are not a code: the code is what a person reads.
const withoutLinks = (s) =>
  s
    .replace(/href\s*=\s*"[^"]*"/gi, "")
    .replace(/https?:\/\/[^\s"'<>]+/g, "");
const sixDigitRuns = (s) => withoutLinks(s).match(/(?<!\d)\d{6}(?!\d)/g) ?? [];
const plain = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");

async function send(email, shouldCreateUser) {
  const { client, jar } = ssrClient();
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { shouldCreateUser, emailRedirectTo: REDIRECT },
  });
  if (error) throw new Error(`probe-m1: signInWithOtp refused ${email}: ${error.message}`);
  const verifier = [...jar.keys()].some((k) => k.endsWith("-code-verifier"));
  const mail = await mailFor(email);
  if (process.env.PROBE_DUMP) console.log(JSON.stringify({ Subject: mail.Subject, Text: mail.Text, HTML: mail.HTML }, null, 1));
  return { verifier, mail };
}

async function confirmedAddress() {
  const email = address();
  const { error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error) throw new Error(`probe-m1: createUser: ${error.message}`);
  return email;
}

function codeOf(mail) {
  const t = sixDigitRuns(mail.Text ?? "");
  const h = sixDigitRuns(mail.HTML ?? "");
  return { t, h, code: t.length === 1 && h.length === 1 && t[0] === h[0] ? t[0] : null };
}

async function verifyCode(email, code) {
  const { client } = ssrClient();
  return client.auth.verifyOtp({ email, token: code, type: "email" });
}

const VERIFY = /https?:\/\/[^\s"'<>]*\/auth\/v1\/verify\?[^\s"'<>]+/g;

try {
  if (runs("u1")) {
    // U1 and «The code is six digits and signs in»: the PKCE send's code verifies by email + token.
    const email = await confirmedAddress();
    const { verifier, mail } = await send(email, false);
    check("U1 · the send is PKCE", verifier, `code-verifier cookie set: ${verifier}`);
    const { t, h, code } = codeOf(mail);
    check("U1 · the mail shows one six-digit code", code !== null, `Text runs ${JSON.stringify(t)}, HTML runs ${JSON.stringify(h)}`);
    if (code) {
      const { data, error } = await verifyCode(email, code);
      check(
        "U1 · verifyOtp({ email, token, type: 'email' }) signs that address in",
        !error && !!data.session && data.user?.email === email,
        error ? `error ${error.code ?? ""} ${error.message}` : `session ${!!data.session}, user.email ${data.user?.email}`,
      );
      const again = await verifyCode(email, code);
      check("the code serves once («sirve una sola vez»)", !!again.error && !again.data.session, again.error ? `second verify: ${again.error.code ?? ""} ${again.error.message}` : "second verify gave a session");
    }
  }

  for (const fresh of wanted.has("u1-hash") ? [false, true] : []) {
    // U1 on today's stack, before any template carries {{ .Token }}: GoTrue's link token is
    // "pkce_" + hex(sha224(email + otp)), the otp {{ .Token }} renders. Recover it from the
    // real PKCE send's link, then verify by email + token as the apps will.
    const email = fresh ? address() : await confirmedAddress();
    const { verifier, mail } = await send(email, fresh);
    console.log(`— ${fresh ? "new address (confirmation mail)" : "confirmed address (magic-link mail)"}`);
    check("U1 · the send is PKCE", verifier, `code-verifier cookie set: ${verifier}`);
    const link = new URL(((mail.Text ?? "").match(VERIFY) ?? [""])[0]);
    const token = link.searchParams.get("token") ?? "";
    check("U1 · the link's token is a PKCE token", token.startsWith("pkce_"), token.slice(0, 12));
    const hash = token.replace(/^pkce_/, "");
    let otp = null;
    for (let n = 0; n < 1_000_000 && otp === null; n += 1) {
      const candidate = String(n).padStart(6, "0");
      if (createHash("sha224").update(email + candidate).digest("hex") === hash) otp = candidate;
    }
    if (otp && process.env.PROBE_WRONG_CODE) otp = String((Number(otp) + 1) % 1_000_000).padStart(6, "0");
    check("U1 · the send's code is six digits", otp !== null, otp === null ? "no six-digit code hashes to the link's token" : "recovered");
    if (otp) {
      const { data, error } = await verifyCode(email, otp);
      check(
        "U1 · verifyOtp({ email, token, type: 'email' }) signs that address in",
        !error && !!data.session && data.user?.email === email,
        error ? `error ${error.code ?? ""} ${error.message}` : `session ${!!data.session}, user.email ${data.user?.email}`,
      );
      const again = await verifyCode(email, otp);
      check("U1 · the code serves once", !!again.error && !again.data.session, again.error ? `second verify: ${again.error.code ?? ""} ${again.error.message}` : "second verify gave a session");
    }
  }

  for (const fresh of [false, true]) {
    const kind = fresh ? "Confirmation mail" : "Magic-link mail";
    const clause = fresh ? "confirmation" : "magic";
    if (![clause, "subject", "words", "link"].some(runs)) continue;
    const email = fresh ? address() : await confirmedAddress();
    const { verifier, mail } = await send(email, fresh);
    const { t, h, code } = codeOf(mail);

    if (runs(clause)) {
      check(`${kind} carries the code`, code !== null, `Text ${JSON.stringify(t)}, HTML ${JSON.stringify(h)}`);
      if (code) {
        const { data, error } = await verifyCode(email, code);
        check(
          `${kind}: its code signs that address in (PKCE send)`,
          verifier && !error && !!data.session && data.user?.email === email,
          error ? `error ${error.code ?? ""} ${error.message}` : `verifier ${verifier}, user.email ${data.user?.email}`,
        );
      }
    }

    if (runs("subject")) {
      check(`${kind}: Subject is «Tu código para entrar: <code>»`, code !== null && mail.Subject === `Tu código para entrar: ${code}`, `Subject ${JSON.stringify(mail.Subject)}, code ${code}`);
    }

    if (runs("words")) {
      const html = plain(mail.HTML ?? "");
      // Auth renders Text from the HTML and writes an anchor as «label ( url )»: the url is checked apart.
      const text = (mail.Text ?? "").replace(/\s*\(\s*https?:\/\/[^\s)]+\s*\)/g, "").replace(/\s+/g, " ");
      const board = [
        "Tu código para entrar",
        "Escríbelo en la pantalla donde lo pediste. Vence en una hora y sirve una sola vez.",
        "¿Lo pediste desde el navegador? También puedes entrar con este enlace, en ese mismo navegador.",
        "Si no lo pediste tú, ignora este correo.",
      ];
      for (const [part, s] of [["HTML", html], ["Text", text]]) {
        const missing = board.filter((line) => !s.includes(line));
        check(`${kind}: ${part} holds the board's four lines`, missing.length === 0, missing.length ? `missing ${JSON.stringify(missing)}; got ${JSON.stringify(s.slice(0, 240))}` : "all found");
        // Board order: heading, the code, «Escríbelo…», the link line, «Si no lo pediste…».
        const positions = [s.indexOf(board[0]), code ? s.indexOf(code) : -1, s.indexOf(board[1]), s.indexOf(board[2]), s.indexOf(board[3])];
        check(`${kind}: ${part} keeps the board's order`, positions.every((i, k) => i >= 0 && (k === 0 || i > positions[k - 1])), `positions ${JSON.stringify(positions)}`);
      }
      const anchor = /<a\b[^>]*href\s*=\s*"([^"]*\/auth\/v1\/verify\?[^"]*)"[^>]*>\s*entrar con este enlace\s*<\/a>/i.exec(mail.HTML ?? "");
      check(`${kind}: «entrar con este enlace» is the verify link's anchor`, !!anchor, anchor ? anchor[1].slice(0, 60) + "…" : "no such anchor");
    }

    if (runs("link")) {
      // As today: …/auth/v1/verify?token=pkce_…&type=…&redirect_to=<app>/auth/confirm, in both parts.
      for (const [part, body] of [["HTML", mail.HTML ?? ""], ["Text", mail.Text ?? ""]]) {
        const found = (body.match(VERIFY) ?? []).map((u) => new URL(u.replaceAll("&amp;", "&")));
        const ok =
          found.length >= 1 &&
          found.every(
            (u) =>
              (u.searchParams.get("token") ?? "").startsWith("pkce_") &&
              ["signup", "magiclink", "email"].includes(u.searchParams.get("type") ?? "") &&
              u.searchParams.get("redirect_to") === REDIRECT,
          );
        check(`${kind}: ${part} carries the PKCE verify link to ${REDIRECT}`, ok, found.map((u) => `token=${(u.searchParams.get("token") ?? "").slice(0, 10)}… type=${u.searchParams.get("type")} redirect_to=${u.searchParams.get("redirect_to")}`).join(" | ") || "no verify link");
      }
    }
  }
} finally {
  for (const email of created) {
    for (let page = 1; ; page += 1) {
      const { data } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      const users = data?.users ?? [];
      for (const u of users) if (u.email === email) await admin.auth.admin.deleteUser(u.id);
      if (users.length < 1000) break;
    }
    const ids = (await search(email)).map((m) => m.ID);
    if (ids.length) await fetch(`${MAILBOX}/api/v1/messages`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ IDs: ids }) });
  }
}

console.log(failed ? "RED" : "GREEN");
process.exit(failed ? 1 : 0);
