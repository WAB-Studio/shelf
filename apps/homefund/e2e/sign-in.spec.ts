
import { randomBytes, randomUUID } from "node:crypto";

import { closeRun, openRun, runId } from "@repo/harness-registry";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { addressKey, callerKey } from "@/lib/auth/client-key";
import { SEED_CATEGORIES } from "@/lib/fund/seed";
import messages from "@/messages/es.json";

import { fixtureSql, purgeAuditTrail, purgeIdentity } from "../scripts/harness/fixtures";
import { clearGroup, test } from "./global-setup";

const auth = messages.auth;
const MAILBOX = "http://127.0.0.1:44324";
const signedOut = { cookies: [], origins: [] };

const stamp = randomUUID().slice(0, 8);
let serial = 0;
const minted: string[] = [];
const listedEmails: string[] = [];
const claimedKeys: string[] = [];

test.skip(({ viewport }) => viewport?.width === 360, "the sign-in facts are read once, on the laptop");

test.beforeAll(async ({ baseURL }) => {
  // Without the salt the caps are open (`noKey`) and every sign-in below would pass for the wrong reason.
  expect(process.env.CLIENT_KEY_SALT?.length ?? 0, "CLIENT_KEY_SALT must be set (>= 16 chars): this file fails, never skips").toBeGreaterThanOrEqual(16);
  // The send creates an `auth.users` row and a mail: only the local stack may receive either.
  const supabase = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://unset.invalid");
  expect(["127.0.0.1", "localhost"], `Supabase is ${supabase.host}, not the local stack`).toContain(supabase.hostname);
  expect(["127.0.0.1", "localhost"], `the app is at ${baseURL}`).toContain(new URL(baseURL!).hostname);
  await openRun("e2e", fixtureSql);
});

test.afterAll(async () => {
  try {
    for (const email of minted) {
      const users = await fixtureSql<{ id: string }[]>`select id from auth.users where email = ${email}`;
      for (const { id } of users) {
        await fixtureSql`delete from harness.identities where user_id = ${id}`;
        await purgeIdentity(id);
        await purgeAuditTrail([id]);
      }
    }
    await clearGroup();
    // By exact address or key: another lane's rows are never reached.
    if (listedEmails.length) await fixtureSql`delete from finances.allowed_emails where email in ${fixtureSql(listedEmails)}`;
    if (claimedKeys.length) await fixtureSql`delete from finances.sign_in_claims where client_key in ${fixtureSql(claimedKeys)}`;
  } finally {
    await closeRun(fixtureSql);
  }
});

function newAddress(domain = "example.invalid"): string {
  serial += 1;
  const email = `harness-signin-${stamp}-${serial}@${domain}`;
  minted.push(email);
  return email;
}

const SALT = process.env.CLIENT_KEY_SALT ?? "";

// A random /64 in 2001:db8::/32 per caller: the caller counter is shared by every lane and rerun.
function newCaller(): string {
  const group = () => randomBytes(2).toString("hex");
  return `2001:db8:${group()}:${group()}:${group()}::1`;
}

// Lists the address by its exact value; the file removes it by that value after.
async function listAddress(email: string) {
  listedEmails.push(email);
  await fixtureSql`insert into finances.allowed_emails (email) values (${email.trim().toLowerCase()})`;
}

async function register(email: string) {
  await fixtureSql`
    insert into harness.identities (user_id, run_id, email, disposition)
    select id, ${runId()}, email, 'ephemeral' from auth.users where email = ${email}
    on conflict do nothing`;
}

// Every context is its own caller, so the daily caller cap never counts another row's sends.
async function fresh(browser: Browser, baseURL: string): Promise<{ context: BrowserContext; page: Page; ip: string }> {
  const ip = newCaller();
  claimedKeys.push(callerKey(new Headers({ "x-forwarded-for": ip }), SALT)!);
  const context = await browser.newContext({ baseURL, storageState: signedOut, extraHTTPHeaders: { "x-forwarded-for": ip } });
  return { context, page: await context.newPage(), ip };
}

async function requestLink(page: Page, email: string, path = "/es/login") {
  claimedKeys.push(addressKey(email, SALT));
  await page.goto(path);
  await page.getByLabel(auth.emailLabel).fill(email);
  await page.getByRole("button", { name: auth.sendLink, exact: true }).click();
  await expect(page.getByRole("heading", { name: auth.sentTitle, exact: true })).toBeVisible();
  await register(email);
}

async function inbox(email: string) {
  const response = await fetch(`${MAILBOX}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
  return (await response.json()) as { messages_count: number; messages: { ID: string }[] };
}

// The link the stack's message carries, rebuilt as the route reads it.
async function confirmPath(email: string): Promise<string> {
  let id = "";
  await expect
    .poll(async () => {
      id = (await inbox(email)).messages[0]?.ID ?? "";
      return id;
    })
    .not.toBe("");
  const message = await (await fetch(`${MAILBOX}/api/v1/message/${id}`)).json();
  const href = /https?:\/\/[^"'\s<>]*\/auth\/v1\/verify\?[^"'\s<>]+/.exec(`${message.HTML}\n${message.Text}`)?.[0];
  if (!href) throw new Error("the mail carries no verify link");
  const verify = new URL(href.replaceAll("&amp;", "&"));
  const token = verify.searchParams.get("token");
  const type = verify.searchParams.get("type");
  if (!token || !type) throw new Error(`the verify link has no token or type: ${href}`);
  return `/auth/confirm?token_hash=${encodeURIComponent(token)}&type=${encodeURIComponent(type)}`;
}

async function userIdOf(email: string): Promise<string> {
  const [row] = await fixtureSql<{ id: string }[]>`select id from auth.users where email = ${email}`;
  return row.id;
}

test("the login form sends one message to the address and says so", async ({ browser, baseURL }) => {
  // Kills: the sign-in action that answers «Revisa tu correo» without asking Auth to send.
  const email = newAddress();
  await listAddress(email);
  const { context, page } = await fresh(browser, baseURL!);
  try {
    await requestLink(page, email);
    await expect(page.getByText(email, { exact: false })).toBeVisible();

    await expect.poll(async () => (await inbox(email)).messages_count).toBe(1);
  } finally {
    await context.close();
  }
});

test("opening the link signs the person in on the app, with the personal categories seeded in Spanish", async ({
  browser,
  baseURL,
}) => {
  // Kills: the first sign-in that skips the seed of the personal category set (RF-64).
  const email = newAddress();
  await listAddress(email);
  const { context, page } = await fresh(browser, baseURL!);
  try {
    await requestLink(page, email);
    await page.goto(await confirmPath(email));

    await expect(page).toHaveURL(/\/es$/);
    expect(await context.cookies()).toContainEqual(expect.objectContaining({ name: expect.stringMatching(/auth-token/) }));
    // Signed in: a page behind the login stays where it is.
    await page.goto("/es/movements");
    await expect(page).toHaveURL(/\/es\/movements$/);

    const userId = await userIdOf(email);
    const seeded = await fixtureSql<{ name: string }[]>`
      select name from categories where owner_user_id = ${userId}`;
    const expected = SEED_CATEGORIES.flatMap((category) => [
      category.name.es,
      ...(category.children ?? []).map((child) => child.name.es),
    ]);
    expect(seeded.map((row) => row.name).sort()).toEqual(expected.sort());
  } finally {
    await context.close();
  }
});

test.describe("sign-out", () => {
  // Signs a new person in through the mailed link, so ending the session never touches the harness user's.
  async function signedIn(browser: Browser, baseURL: string) {
    const email = newAddress();
    await listAddress(email);
    const opened = await fresh(browser, baseURL);
    await requestLink(opened.page, email);
    await opened.page.goto(await confirmPath(email));
    await expect(opened.page).toHaveURL(/\/es$/);
    await opened.page.goto("/es/settings");
    return opened;
  }

  test("an ordinary sign-out lands on the login", async ({ browser, baseURL }) => {
    // Kills: an onError that toasts a sign-out that worked.
    const { context, page } = await signedIn(browser, baseURL!);
    try {
      await page.getByRole("button", { name: auth.signOut, exact: true }).click();
      await expect(page).toHaveURL(/\/es\/login/);
    } finally {
      await context.close();
    }
  });
});
