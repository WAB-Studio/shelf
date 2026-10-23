import { randomUUID } from "node:crypto";

import type postgres from "postgres";

import account from "../messages/es/account.json";
import { invite } from "./entrar-invitado";
import { test, expect, visit } from "./fixtures";

// M65: GoalLog's sign-in is closed to sign-up. The list names who may come in, and a send never
// makes an Auth user of its own: the invitation's user exists before the send, or the send is refused.

const signedOut = { cookies: [], origins: [] };
const MAILBOX = "http://127.0.0.1:44324";

function invitee(): string {
  return `harness-inv-${randomUUID()}@gmail.com`;
}

async function usersWith(db: postgres.Sql, email: string): Promise<number> {
  const [{ n }] = await db<{ n: number }[]>`select count(*)::int as n from auth.users where email = ${email}`;
  return n;
}

async function mailsTo(email: string): Promise<number> {
  const found = await (await fetch(`${MAILBOX}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
  return found.messages_count;
}

async function drop(db: postgres.Sql, email: string) {
  const ids = await db<{ id: string }[]>`select id from auth.users where email = ${email}`;
  for (const { id } of ids) {
    await db`delete from harness.identities where user_id = ${id}`;
    await db`delete from auth.users where id = ${id}`;
  }
  await db`delete from goals.allowed_emails where email = ${email}`;
}

test("a send for a listed address with no Auth user creates no auth.users row, sends no mail and reads sendFailed", async ({
  browser,
  baseURL,
  db,
}) => {
  // Kills: `shouldCreateUser: true` (the row appears and the mail goes), or the refusal read as sent.
  const email = invitee();
  await db`insert into goals.allowed_emails (email) values (${email})`;
  expect(await usersWith(db, email)).toBe(0);
  const context = await browser.newContext({ baseURL, storageState: signedOut, viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  try {
    await visit(page, "/entrar");
    await page.getByLabel(account.emailLabel).fill(email);
    await page.getByRole("button", { name: account.action, exact: true }).click();
    await expect(page.getByText(account.errors.sendFailed, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: account.sentTitle, exact: true })).toHaveCount(0);
    expect(await usersWith(db, email)).toBe(0);
    expect(await db`select 1 from auth.one_time_tokens where relates_to = ${email}`).toHaveLength(0);
    expect(await mailsTo(email)).toBe(0);
  } finally {
    await context.close();
    await drop(db, email);
  }
});

test("a send for an invited address with a registered user sends one mail, adds no second row, and leaves no harness-inv row outside harness.identities", async ({
  browser,
  baseURL,
  db,
}) => {
  // Kills: a send that adds a second row for the address, or a user minted outside the registry.
  const email = invitee();
  const id = await invite(db, email);
  const context = await browser.newContext({ baseURL, storageState: signedOut, viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  try {
    await visit(page, "/entrar");
    await page.getByLabel(account.emailLabel).fill(email);
    await page.getByRole("button", { name: account.action, exact: true }).click();
    await expect(page.getByRole("heading", { name: account.sentTitle, exact: true })).toBeVisible();
    await expect.poll(() => mailsTo(email)).toBe(1);
    expect(await usersWith(db, email)).toBe(1);
    const ids = await db<{ user_id: string }[]>`select user_id from harness.identities where email = ${email} and disposition = 'ephemeral'`;
    expect(ids.map((row) => row.user_id)).toEqual([id]);
    // No harness-inv user of this run stands outside the registry (the census, whatever the domain).
    const stray = await db`
      select u.email from auth.users u
      where u.email like 'harness-inv-%' and coalesce(u.created_at, now()) >= (select started_at from harness.runs where id = ${process.env.HARNESS_RUN_ID!})
        and not exists (select 1 from harness.identities i where i.user_id = u.id)`;
    expect(stray).toHaveLength(0);
  } finally {
    await context.close();
    await drop(db, email);
  }
});
