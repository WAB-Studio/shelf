import { randomBytes, randomUUID } from "node:crypto";

import type { Browser, BrowserContext } from "@playwright/test";
import type postgres from "postgres";

import { test, expect } from "./fixtures";
import account from "../messages/es/account.json";
import { dayFromToday, noonFromToday } from "./reloj";
import { boxOf } from "./box";

// RP-18: a person comes in by the link sent to their address, and what they
// write is theirs on every device they sign in on. The link's own landing is
// driven by a token row landed by hand — nothing here opens the form, types an
// address or asks Auth to send (a send reaches a real inbox). Each redemption
// is one `verifyOtp` against Auth, whose rate limit every lane shares: this
// file spends three per run.

const signedOut = { cookies: [], origins: [] };

async function createPerson(db: postgres.Sql): Promise<string> {
  const runId = process.env.HARNESS_RUN_ID?.trim();
  if (!runId) throw new Error("HARNESS_RUN_ID is unset: this spec runs under check:e2e's own run");
  const id = randomUUID();
  const email = `harness-pulsar-${id}@example.invalid`;
  await db.begin(async (tx) => {
    await tx`
      insert into auth.users (
        id, instance_id, aud, role, email, email_confirmed_at,
        encrypted_password, confirmation_token, recovery_token,
        email_change, email_change_token_current, email_change_token_new,
        email_change_confirm_status, phone_change, phone_change_token,
        reauthentication_token, raw_app_meta_data, raw_user_meta_data,
        is_sso_user, is_anonymous, created_at, updated_at)
      values (
        ${id}, '00000000-0000-0000-0000-000000000000', 'authenticated',
        'authenticated', ${email}, now(),
        '', '', '',
        '', '', '',
        0, '', '',
        '', '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
        false, false, now(), now())`;
    await tx`
      insert into harness.identities (user_id, run_id, email, disposition)
      values (${id}, ${runId}, ${email}, 'ephemeral')`;
  });
  return id;
}

async function dropPerson(db: postgres.Sql, id: string) {
  await db`delete from goals.facts where user_id = ${id}`;
  await db`delete from goals.goals where user_id = ${id}`;
  await db`delete from auth.users where id = ${id}`;
  await db`delete from harness.identities where user_id = ${id}`;
}

async function mintToken(db: postgres.Sql, personId: string): Promise<string> {
  const hash = randomBytes(32).toString("hex");
  const [{ email }] = await db<{ email: string }[]>`
    update auth.users set recovery_token = ${hash}, recovery_sent_at = now(), updated_at = now()
    where id = ${personId} returning email`;
  await db`
    insert into auth.one_time_tokens (id, user_id, token_type, token_hash, relates_to, created_at, updated_at)
    values (${randomUUID()}, ${personId}, 'recovery_token', ${hash}, ${email}, now(), now())`;
  return hash;
}

async function redeem(context: BrowserContext, hash: string) {
  return context.request.get(`/auth/confirm?token_hash=${hash}&type=magiclink`, { maxRedirects: 0 });
}

async function freshContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  return browser.newContext({ baseURL, storageState: signedOut });
}

test("a valid link lands on Hoy with a session that reads the person's own day, and the same person's second device sees what the first wrote (RP-18)", async ({
  browser,
  baseURL,
  db,
}) => {
  const personId = await createPerson(db);
  const stamp = Date.now();
  const first = `Entrar primero ${stamp}`;
  const second = `Entrar segundo ${stamp}`;
  const contexts: BrowserContext[] = [];
  try {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${personId}, ${`Meta entrar ${stamp}`}, ${dayFromToday(60)}, ${noonFromToday(-10)})
      returning id`;
    for (const name of [first, second]) {
      await db`
        insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
        values (${personId}, ${goal.id}, ${name}, 'daily', 'tap', ${noonFromToday(-10)})`;
    }

    const a = await freshContext(browser, baseURL!);
    const b = await freshContext(browser, baseURL!);
    contexts.push(a, b);

    // The landing: one redirect to Hoy, and the cookie it sets is a session.
    const landing = await redeem(a, await mintToken(db, personId));
    expect(landing.status()).toBe(307);
    expect(new URL(landing.headers()["location"]).pathname).toBe("/");
    expect(new URL(landing.headers()["location"]).search).toBe("");
    const pageA = await a.newPage();
    await pageA.goto("/");
    await expect(pageA).toHaveURL(/\/$/);
    await expect(pageA.getByText("hechos 0 de 2", { exact: true })).toBeVisible();

    // Device two signs in through its own token — a different session, one person.
    const landingB = await redeem(b, await mintToken(db, personId));
    expect(new URL(landingB.headers()["location"]).pathname).toBe("/");
    const pageB = await b.newPage();
    await pageB.goto("/");
    await expect(pageB.getByText("hechos 0 de 2", { exact: true })).toBeVisible();
    const [{ sessions }] = await db<{ sessions: number }[]>`
      select count(*)::int as sessions from auth.sessions where user_id = ${personId}`;
    expect(sessions).toBe(2);

    await pageA.getByRole("button", { name: new RegExp(`^${first}`) }).click();
    await expect(pageA.getByText("hechos 1 de 2", { exact: true })).toBeVisible();
    await expect
      .poll(async () => (await db`select id from goals.facts where user_id = ${personId}`).length)
      .toBe(1);

    await pageB.reload();
    await expect(pageB.getByText("hechos 1 de 2", { exact: true })).toBeVisible();
  } finally {
    for (const context of contexts) await context.close();
    await dropPerson(db, personId);
  }
});

test("a token Auth does not know sends the person to /entrar with linkInvalid (RP-18)", async ({
  browser,
  baseURL,
}) => {
  const context = await freshContext(browser, baseURL!);
  try {
    const response = await context.request.get(
      `/auth/confirm?token_hash=${randomBytes(32).toString("hex")}&type=magiclink`,
      { maxRedirects: 0 },
    );
    expect(response.status()).toBe(307);
    const location = new URL(response.headers()["location"]);
    expect(location.pathname).toBe("/entrar");
    expect(location.searchParams.get("error")).toBe("linkInvalid");

    // And no session came with it.
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(/\/entrar$/);
  } finally {
    await context.close();
  }
});

test("a link with no token, or no type, never reaches a session and says linkInvalid (RP-18)", async ({
  browser,
  baseURL,
}) => {
  const context = await freshContext(browser, baseURL!);
  try {
    for (const query of ["", "?type=magiclink", "?token_hash=", "?token_hash=abc"]) {
      const response = await context.request.get(`/auth/confirm${query}`, { maxRedirects: 0 });
      expect(response.status(), query).toBe(307);
      const location = new URL(response.headers()["location"]);
      expect(location.pathname, query).toBe("/entrar");
      expect(location.searchParams.get("error"), query).toBe("linkInvalid");
      expect(response.headersArray().some((h) => h.name.toLowerCase() === "set-cookie"), query).toBe(false);
    }
  } finally {
    await context.close();
  }
});

test("/entrar says why the link failed above the field, in the catalogue's words, and says nothing for an error that is not the link's (RP-18)", async ({
  browser,
  baseURL,
}) => {
  const context = await freshContext(browser, baseURL!);
  try {
    const page = await context.newPage();
    const { errors } = account;

    for (const [key, title, body] of [
      ["linkInvalid", errors.linkInvalidTitle, errors.linkInvalidBody],
      ["linkTimeout", errors.linkTimeoutTitle, errors.linkTimeoutBody],
    ] as const) {
      await page.goto(`/entrar?error=${key}`);
      const field = page.getByLabel(account.emailLabel);
      await expect(field).toBeVisible();
      await expect(page.getByText(title, { exact: true })).toBeVisible();
      await expect(page.getByText(body, { exact: true })).toBeVisible();
      const titleBox = (await boxOf(page.getByText(title, { exact: true })));
      const bodyBox = (await boxOf(page.getByText(body, { exact: true })));
      const fieldBox = (await boxOf(field));
      expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(fieldBox.y);
      expect(bodyBox.y + bodyBox.height).toBeLessThanOrEqual(fieldBox.y);
    }

    await page.goto("/entrar?error=algoAjeno");
    await expect(page.getByLabel(account.emailLabel)).toBeVisible();
    for (const text of [account.errors.linkInvalidTitle, account.errors.linkTimeoutTitle]) {
      await expect(page.getByText(text, { exact: true })).toHaveCount(0);
    }

    await page.goto("/entrar");
    await expect(page.getByLabel(account.emailLabel)).toBeVisible();
    await expect(page.getByText(account.errors.linkInvalidTitle, { exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("with no session, Hoy and Semana land on /entrar (RP-18)", async ({ browser, baseURL }) => {
  const context = await freshContext(browser, baseURL!);
  try {
    const page = await context.newPage();
    for (const path of ["/", "/semana"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/entrar$/);
      await expect(page.getByLabel(account.emailLabel), path).toBeVisible();
    }
  } finally {
    await context.close();
  }
});

test("/entrar names the app and sits in the centred column at 1280 (318)", async ({
  browser,
  baseURL,
}) => {
  const context = await freshContext(browser, baseURL!);
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/entrar");
    const title = page.getByRole("heading", { level: 1, name: account.title });
    await expect(title).toBeVisible();
    await expect(page.getByText(account.eyebrow, { exact: true })).toBeVisible();
    expect((await boxOf(title)).x).toBeGreaterThanOrEqual(300);
  } finally {
    await context.close();
  }
});
