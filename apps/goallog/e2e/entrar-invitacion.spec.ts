import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import account from "../messages/es/account.json";
import { invite } from "./entrar-invitado";
import { test, expect, seededPerson, visit } from "./fixtures";

// RP-131: GoalLog lets in only the addresses on `goals.allowed_emails`. Every send here goes to the
// local stack's inbox (mailpit, :44324), never out: the address is a deliverable domain only
// because the domain guard answers before the send, and each spec runs under
// `scripts/supabase-local.sh exec`. The link is the PKCE one: its `code` is built from the token
// row Auth wrote and Auth's own verify redirect, as the mail's button would.

const signedOut = { cookies: [], origins: [] };
const MAILBOX = "http://127.0.0.1:44324";

function invitee(): string {
  return `harness-inv-${randomUUID()}@gmail.com`;
}

// The invited user is registered under the suite's run, so a crash leaves it to the teardown; dropped by exact address here.
async function forget(db: postgres.Sql, email: string) {
  const ids = await db<{ id: string }[]>`select id from auth.users where email = ${email}`;
  for (const { id } of ids) {
    await db`delete from harness.identities where user_id = ${id}`;
    await db`delete from auth.users where id = ${id}`;
  }
  await db`delete from goals.allowed_emails where email = ${email}`;
}

async function open(browser: Browser, baseURL: string, viewport = { width: 360, height: 740 }) {
  const context = await browser.newContext({ baseURL, storageState: signedOut, viewport, hasTouch: true });
  return { context, page: await context.newPage() };
}

async function submit(page: Page, email: string) {
  await visit(page, "/entrar");
  await page.getByLabel(account.emailLabel).fill(email);
  await page.getByRole("button", { name: account.action, exact: true }).click();
}

// The PKCE link as the mail's button carries it, read from the local inbox: Auth's verify URL,
// which redirects to this app with `?code=`. Opening Auth's verify is what Gmail's click does.
async function codeLink(email: string): Promise<string> {
  let id = "";
  await expect
    .poll(async () => {
      const found = await (await fetch(`${MAILBOX}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
      id = found.messages?.[0]?.ID ?? "";
      return id;
    })
    .not.toBe("");
  const message = await (await fetch(`${MAILBOX}/api/v1/message/${id}`)).json();
  const href = /https?:\/\/[^"'\s<>]*\/auth\/v1\/verify\?[^"'\s<>]+/.exec(`${message.HTML}\n${message.Text}`)?.[0];
  if (!href) throw new Error("the mail carries no verify link");
  const verify = new URL(href.replaceAll("&amp;", "&"));
  const answer = await fetch(verify, { redirect: "manual" });
  const location = answer.headers.get("location");
  if (!location) throw new Error(`Auth's verify answered ${answer.status} with no redirect`);
  const landed = new URL(location);
  expect(landed.pathname).toBe("/auth/confirm");
  expect(landed.searchParams.get("code"), location).toBeTruthy();
  return `${landed.pathname}${landed.search}`;
}

async function sessionsOf(db: postgres.Sql, email: string): Promise<number> {
  const [{ n }] = await db<{ n: number }[]>`
    select count(*)::int as n from auth.sessions s join auth.users u on u.id = s.user_id where u.email = ${email}`;
  return n;
}

test("an address not on the list reads the refusal under the field, and Auth is never asked: no user, no token", async ({
  browser,
  baseURL,
  db,
}) => {
  // Kills: the list read after `signInWithOtp` (the row and the token appear), or no read at all.
  const email = invitee();
  const { context, page } = await open(browser, baseURL!);
  try {
    await submit(page, email);
    await expect(page.getByText(account.errors.notInvited, { exact: true })).toBeVisible();
    await expect(page.getByLabel(account.emailLabel)).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText(account.sentTitle, { exact: true })).toHaveCount(0);
    expect(await db`select 1 from auth.users where email = ${email}`).toHaveLength(0);
    expect(await db`select 1 from auth.one_time_tokens where relates_to = ${email}`).toHaveLength(0);
    const sent = await (await fetch(`${MAILBOX}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    expect(sent.messages_count).toBe(0);
  } finally {
    await context.close();
    await forget(db, email);
  }
});

test("a listed address reads «Revisa tu correo» with the address, and the mail lands in the local inbox", async ({
  browser,
  baseURL,
  db,
}) => {
  // Kills: the list refusing an address it holds (compared without lower/trim, or inverted).
  const email = invitee();
  await invite(db, email);
  const { context, page } = await open(browser, baseURL!);
  try {
    // Typed in capitals: the list holds it lowercase.
    await submit(page, email.toUpperCase());
    await expect(page.getByRole("heading", { name: account.sentTitle, exact: true })).toBeVisible();
    await expect(page.getByText(account.errors.notInvited, { exact: true })).toHaveCount(0);
    await expect
      .poll(async () => {
        const found = await (await fetch(`${MAILBOX}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
        return found.messages_count;
      })
      .toBe(1);
  } finally {
    await context.close();
    await forget(db, email);
  }
});

test("the button reads «Enviando…» and stays disabled until the answer comes, then the send is done", async ({
  browser,
  baseURL,
  db,
}) => {
  // Kills: the pending label dropped or the button left enabled while the action runs.
  const email = invitee();
  await invite(db, email);
  const { context, page } = await open(browser, baseURL!);
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => (release = resolveGate));
  try {
    await page.route("**/entrar", async (route) => {
      if (route.request().method() === "POST") await gate;
      await route.continue();
    });
    await submit(page, email);
    const pending = page.getByRole("button", { name: account.sending, exact: true });
    await expect(pending).toBeVisible();
    await expect(pending).toBeDisabled();
    await expect(page.getByRole("button", { name: account.action, exact: true })).toHaveCount(0);
    release();
    await expect(page.getByRole("heading", { name: account.sentTitle, exact: true })).toBeVisible();
  } finally {
    release();
    await context.close();
    await forget(db, email);
  }
});

test("the code link opened in a second browser lands on the other-browser notice and signs nobody in; in the browser that asked it signs in", async ({
  browser,
  baseURL,
  db,
}) => {
  // Kills: `linkOtherBrowser` dropped from LINK_ERRORS (the notice never draws), or the route
  // exchanging the code without the asking browser's verifier (a session appears in the second).
  const email = invitee();
  await invite(db, email);
  const first = await open(browser, baseURL!);
  const second = await open(browser, baseURL!);
  try {
    await submit(first.page, email);
    await expect(first.page.getByRole("heading", { name: account.sentTitle, exact: true })).toBeVisible();
    const link = await codeLink(email);

    await second.page.goto(link);
    await expect(second.page).toHaveURL(/\/entrar\?error=linkOtherBrowser$/);
    await expect(second.page.getByText(account.errors.linkOtherBrowserTitle, { exact: true })).toBeVisible();
    await expect(second.page.getByText(account.errors.linkOtherBrowserBody, { exact: true })).toBeVisible();
    await expect(second.page.getByText(account.errors.linkInvalidTitle, { exact: true })).toHaveCount(0);
    expect(await sessionsOf(db, email)).toBe(0);
    expect(await second.context.cookies()).not.toContainEqual(expect.objectContaining({ name: expect.stringContaining("auth-token") }));

    // The refusal spent nothing: the same link still signs in where it was asked for.
    await first.page.goto(link);
    await expect(first.page).toHaveURL(/\/$/);
    expect(await sessionsOf(db, email)).toBe(1);
  } finally {
    await first.context.close();
    await second.context.close();
    await forget(db, email);
  }
});

test("the notice sits above the field and holds at 360 without horizontal scroll", async ({ browser, baseURL }) => {
  // Kills: the notice drawn under the form, or a title that overflows the column.
  const { context, page } = await open(browser, baseURL!);
  try {
    await visit(page, "/entrar?error=linkOtherBrowser");
    const title = page.getByText(account.errors.linkOtherBrowserTitle, { exact: true });
    await expect(title).toBeVisible();
    await expect(page.getByLabel(account.emailLabel)).toBeVisible();
    const [noticeBox, fieldBox] = [await title.boundingBox(), await page.getByLabel(account.emailLabel).boundingBox()];
    expect(noticeBox!.y + noticeBox!.height).toBeLessThanOrEqual(fieldBox!.y);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    await page.getByLabel(account.emailLabel).fill(invitee());
    await page.getByRole("button", { name: account.action, exact: true }).click();
    await expect(page.getByText(account.errors.notInvited, { exact: true })).toBeVisible();
    const after = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(after).toBeLessThanOrEqual(0);
  } finally {
    await context.close();
  }
});

test("the harness person is on the list; a run's drop takes its address by exact match and no other lane's", async ({
  db,
}) => {
  // Kills: mint-session not inserting its email; e2e-run not deleting it, or deleting every
  // `harness%@example.invalid` row (a stranger's survives only by exact address).
  const mine = seededPerson().email;
  expect(await db`select 1 from goals.allowed_emails where email = ${mine}`).toHaveLength(1);

  const file = `private/disposable/${randomUUID()}.json`;
  try {
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", "--env-file=.env.local", "e2e/entrar-invitacion-sonda.ts"],
      { env: { ...process.env, HARNESS_RUN_ID: "", MINT_SESSION_FILE: file }, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    const line = out.split("\n").find((l) => l.startsWith("RESULT "));
    expect(line, out).toBeTruthy();
    const result = JSON.parse(line!.slice("RESULT ".length));
    expect(result.email).toMatch(/^harness-pulsar-.+@example\.invalid$/);
    expect(result.before).toBe(true);
    expect(result.after).toBe(false);
    expect(result.strangerKept).toBe(true);
  } finally {
    rmSync(resolve(process.cwd(), file), { force: true });
  }
});

test.describe("npm run allow-email", () => {
  // CI's .env.local carries no service-role key; the local stack's comes from the CLI, as in check:allow-email.
  let serviceKey = "";
  test.beforeAll(() => {
    const out = execFileSync("npx", ["--yes", "supabase@2.119.0", "status", "-o", "env"], {
      cwd: resolve(process.cwd(), "../.."),
      encoding: "utf8",
    });
    serviceKey = /^SERVICE_ROLE_KEY="(.*)"$/m.exec(out)?.[1] ?? "";
    expect(serviceKey, "the local stack gave no service-role key").not.toBe("");
  });
  const run = (...args: string[]) =>
    spawnSync("npm", ["run", "--silent", "allow-email", "--", ...args], {
      env: { ...process.env, SUPABASE_SERVICE_ROLE_KEY: serviceKey },
      encoding: "utf8",
    });

  test("lists the address in lowercase, says «ya estaba» the second time, and refuses a malformed one", async ({ db }) => {
    // Kills: the address stored as typed, a second run that does not say it was already there,
    // a malformed address that exits 0 or lands a row.
    const stem = randomUUID();
    const typed = `Allow.${stem}@Example.COM`;
    const stored = typed.toLowerCase();
    try {
      const first = run(typed);
      expect(first.status, first.stderr).toBe(0);
      expect(`${first.stdout}${first.stderr}`).not.toMatch(/ya estaba/i);
      expect(await db`select email from goals.allowed_emails where email = ${stored}`).toHaveLength(1);
      expect(await db`select 1 from goals.allowed_emails where email = ${typed}`).toHaveLength(0);

      const second = run(typed);
      expect(second.status, second.stderr).toBe(0);
      expect(`${second.stdout}${second.stderr}`).toMatch(/ya estaba/i);
      expect(await db`select 1 from goals.allowed_emails where email = ${stored}`).toHaveLength(1);

      const bad = run("foo");
      expect(bad.status).not.toBe(0);
      expect(await db`select 1 from goals.allowed_emails where email = 'foo'`).toHaveLength(0);
    } finally {
      await db`delete from goals.allowed_emails where email = ${stored}`;
    }
  });
});
