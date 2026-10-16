/**
 * Passwordless sign-in end to end (RF-01), through the local stack's mailbox.
 *
 * Every send goes to the local Auth and lands in its mailpit (:54324); nothing
 * leaves the machine, and the spec refuses to run against any other stack. The
 * addresses end in `.invalid`, so even a leak could not be delivered.
 *
 * The link is opened the way the production template builds it: the route reads
 * `token_hash` and `type` (`app/auth/confirm/route.ts`), so the spec takes both
 * from the message the stack really sent: the verify URL in the mail carries the
 * hashed token as its `token` and the kind of link as its `type`, and the same
 * pair goes into `/auth/confirm?token_hash=…&type=…`.
 *
 * Each address is registered under this worker's run the moment Auth has
 * created it, and its rows are dropped after the file, so the census finds no
 * identity the registry does not know.
 */
import { randomUUID } from "node:crypto";

import { closeRun, openRun, runId } from "@repo/harness-registry";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { SEED_CATEGORIES } from "@/lib/fund/seed";
import messages from "@/messages/es.json";

import { fixtureSql, purgeAuditTrail, purgeIdentity } from "../scripts/harness/fixtures";
import { asHarnessUser, clearGroup, seedGroup, test } from "./global-setup";

const auth = messages.auth;
const MAILBOX = "http://127.0.0.1:54324";
const signedOut = { cookies: [], origins: [] };

const stamp = randomUUID().slice(0, 8);
let serial = 0;
const minted: string[] = [];

test.skip(({ viewport }) => viewport?.width === 360, "the sign-in facts are read once, on the laptop");

test.beforeAll(async ({ baseURL }) => {
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
  } finally {
    await closeRun(fixtureSql);
  }
});

function newAddress(): string {
  serial += 1;
  const email = `harness-signin-${stamp}-${serial}@example.invalid`;
  minted.push(email);
  return email;
}

async function register(email: string) {
  await fixtureSql`
    insert into harness.identities (user_id, run_id, email, disposition)
    select id, ${runId()}, email, 'ephemeral' from auth.users where email = ${email}
    on conflict do nothing`;
}

async function fresh(browser: Browser, baseURL: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL, storageState: signedOut });
  return { context, page: await context.newPage() };
}

async function requestLink(page: Page, email: string, path = "/es/login") {
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

test("an address pending as a member signs in and lands as that member, not as a new one", async ({
  browser,
  baseURL,
}) => {
  // Kills: the sign-in that never claims the invitation (RF-06), so the person lands in no fund.
  const email = newAddress();
  const { groupId } = await seedGroup();
  const pendingId = randomUUID();
  await asHarnessUser(async (tx) => {
    await tx`
      insert into group_members (id, group_id, name, role, invite_email)
      values (${pendingId}, ${groupId}, ${`Invitado E9 ${stamp}`}, 'member', ${email})`;
  });
  const [before] = await fixtureSql<{ n: number }[]>`
    select count(*)::int as n from group_members where group_id = ${groupId}`;

  const { context, page } = await fresh(browser, baseURL!);
  try {
    await requestLink(page, email);
    await page.goto(await confirmPath(email));

    await expect(page).toHaveURL(/\/es\/bienvenida$/);

    const userId = await userIdOf(email);
    const [member] = await fixtureSql<{ id: string; name: string; user_id: string | null }[]>`
      select id, name, user_id from group_members where id = ${pendingId}`;
    expect(member).toEqual({ id: pendingId, name: `Invitado E9 ${stamp}`, user_id: userId });
    const [after] = await fixtureSql<{ n: number }[]>`
      select count(*)::int as n from group_members where group_id = ${groupId}`;
    expect(after.n).toBe(before.n);
  } finally {
    await context.close();
    await clearGroup();
  }
});

test("the page asked for before signing in is where the link lands", async ({ browser, baseURL }) => {
  // Kills: the destination dropped between the login form and the link.
  const email = newAddress();
  const { context, page } = await fresh(browser, baseURL!);
  try {
    await page.goto("/es/movements");
    await expect(page).toHaveURL(/\/es\/login\?next=/);
    await page.getByLabel(auth.emailLabel).fill(email);
    await page.getByRole("button", { name: auth.sendLink, exact: true }).click();
    await expect(page.getByRole("heading", { name: auth.sentTitle, exact: true })).toBeVisible();
    await register(email);

    await page.goto(await confirmPath(email));
    await expect(page).toHaveURL(/\/es\/movements$/);
  } finally {
    await context.close();
  }
});

test("a destination outside the app is ignored: the link lands on the home page", async ({ browser, baseURL }) => {
  // Kills: the redirect that follows any `next` it is given.
  const email = newAddress();
  const { context, page } = await fresh(browser, baseURL!);
  try {
    await requestLink(page, email, "/es/login?next=//evil.example/steal");
    await page.goto(await confirmPath(email));

    await expect(page).toHaveURL(/\/es$/);
    expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
  } finally {
    await context.close();
  }
});

test("a link opened a second time lands on the login with the invalid-link notice", async ({ browser, baseURL }) => {
  // Kills: the route that treats a spent link as a good one.
  const email = newAddress();
  const first = await fresh(browser, baseURL!);
  const second = await fresh(browser, baseURL!);
  try {
    await requestLink(first.page, email);
    const path = await confirmPath(email);

    await first.page.goto(path);
    await expect(first.page).toHaveURL(/\/es$/);

    await second.page.goto(path);
    await expect(second.page).toHaveURL(/\/es\/login\?error=linkInvalid$/);
    await expect(second.page.getByText(messages.errors.linkInvalid, { exact: true })).toBeVisible();
    expect(await second.context.cookies()).not.toContainEqual(
      expect.objectContaining({ name: expect.stringMatching(/auth-token/) }),
    );
  } finally {
    await first.context.close();
    await second.context.close();
  }
});

test("every address this file minted is in the harness registry under this run", async () => {
  // Kills: an identity left out of the registry, which the census would count as a leak.
  expect(minted.length).toBeGreaterThan(0);
  const rows = await fixtureSql<{ email: string; run_id: string | null; disposition: string }[]>`
    select u.email, i.run_id, i.disposition
    from auth.users u
    left join harness.identities i on i.user_id = u.id
    where u.email like ${`harness-signin-${stamp}-%`}`;
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row, row.email).toMatchObject({ run_id: runId(), disposition: "ephemeral" });
  }
});
