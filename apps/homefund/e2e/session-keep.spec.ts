/**
 * RF-190: a device that keeps being used stays signed in, and «Mantener la sesión abierta»
 * signs it out after the days of inactivity the person chose.
 *
 * Every test drives a clone of the harness user's session, not the cached one: a refresh rotates
 * the refresh token, a sign-out revokes the session, and either would leave the cached file —
 * the only way back in — pointing at a dead token.
 */
import { randomUUID } from "node:crypto";

import { expect, type BrowserContext } from "@playwright/test";

import es from "@/messages/es.json";

import { cookiesOf, HARNESS_BASE_URL, refreshSession, type HarnessSession } from "../scripts/harness/session";
import { fixtureSql } from "../scripts/harness/fixtures";
import { readScope, test } from "./global-setup";

const DAY_SECONDS = 24 * 60 * 60;

// A fresh session of the harness user, sharing the original's login but none of its refresh tokens.
async function cloneSession(userId: string): Promise<{ session: HarnessSession; sessionId: string }> {
  const sessionId = randomUUID();
  const token = randomUUID().replaceAll("-", "");

  await fixtureSql.begin(async (tx) => {
    await tx`create temp table session_clone on commit drop as
      select * from auth.sessions where user_id = ${userId} order by created_at desc limit 1`;
    await tx`update session_clone set id = ${sessionId}`;
    await tx`insert into auth.sessions select * from session_clone`;
    await tx`
      insert into auth.refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, session_id)
      select instance_id, ${token}, user_id, false, now(), now(), ${sessionId}
      from auth.refresh_tokens where user_id = ${userId} limit 1`;
  });

  const session = await refreshSession(token);
  if (!session) throw new Error("the cloned session would not refresh");

  return { session, sessionId };
}

async function dropClone(sessionId: string): Promise<void> {
  await fixtureSql`delete from auth.sessions where id = ${sessionId}`;
}

async function setKeepDays(userId: string, days: number | null): Promise<void> {
  await fixtureSql`
    update auth.users
    set raw_user_meta_data = case when ${days}::int is null
      then coalesce(raw_user_meta_data, '{}'::jsonb) - 'keep_signed_in_days'
      else coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('keep_signed_in_days', ${days}::int) end
    where id = ${userId}`;
}

async function signInAs(context: BrowserContext, session: HarnessSession, lastSeenDaysAgo?: number): Promise<void> {
  const { hostname } = new URL(HARNESS_BASE_URL);
  const cookies = cookiesOf(session).map(({ name, value }) => ({ name, value, domain: hostname, path: "/" }));
  if (lastSeenDaysAgo !== undefined) {
    cookies.push({
      name: "homefund-last-seen",
      value: String(Date.now() - lastSeenDaysAgo * DAY_SECONDS * 1000),
      domain: hostname,
      path: "/",
    });
  }
  await context.addCookies(cookies);
}

async function refreshTokenIn(context: BrowserContext): Promise<string> {
  const chunks = (await context.cookies())
    .filter(({ name }) => /^sb-.+-auth-token(\.\d+)?$/.test(name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const joined = chunks.map(({ value }) => value).join("");
  const decoded = JSON.parse(Buffer.from(joined.replace(/^base64-/, ""), "base64").toString("utf8")) as HarnessSession;

  return decoded.refresh_token;
}

async function sessionAlive(sessionId: string): Promise<boolean> {
  const [{ count }] = await fixtureSql<{ count: number }[]>`
    select count(*)::int as count from auth.sessions where id = ${sessionId}`;
  return count === 1;
}

test.use({ storageState: { cookies: [], origins: [] } });

test("an expired access token is refreshed through the proxy and the person stays signed in", async ({ context, page }) => {
  // Kills: the proxy treating an expired access token as signed out, or dropping its refreshed cookies.
  const { userId } = readScope();
  const { session, sessionId } = await cloneSession(userId);

  try {
    await signInAs(context, { ...session, expires_at: Math.floor(Date.now() / 1000) - 60 });

    // Several requests at once with the same expired token, as a phone waking up sends them.
    const answers = await Promise.all([1, 2, 3].map(() => page.request.get("/es/settings")));
    for (const answer of answers) {
      expect(answer.status()).toBe(200);
      expect(answer.url()).not.toContain("/login");
    }

    await page.goto("/es/settings");
    await expect(page).not.toHaveURL(/\/login/);
    expect(await refreshTokenIn(context)).not.toBe(session.refresh_token);
    expect(await sessionAlive(sessionId)).toBe(true);
  } finally {
    await dropClone(sessionId);
  }
});

test("a device unused for longer than the chosen days is signed out", async ({ context, page }) => {
  // Kills: the proxy never reading the limit, or reading the stamp in the wrong unit.
  const { userId } = readScope();
  await setKeepDays(userId, 7);
  const { session, sessionId } = await cloneSession(userId);

  try {
    await signInAs(context, session, 8);
    await page.goto("/es/settings");

    await expect(page).toHaveURL(/\/login/);
    expect(await sessionAlive(sessionId)).toBe(false);
  } finally {
    await setKeepDays(userId, null);
    await dropClone(sessionId);
  }
});

test("a device used inside the chosen days stays signed in", async ({ context, page }) => {
  // Kills: a limit that signs out every device, whatever its last request.
  const { userId } = readScope();
  await setKeepDays(userId, 7);
  const { session, sessionId } = await cloneSession(userId);

  try {
    await signInAs(context, session, 6);
    await page.goto("/es/settings");

    await expect(page).not.toHaveURL(/\/login/);
    expect(await sessionAlive(sessionId)).toBe(true);
  } finally {
    await setKeepDays(userId, null);
    await dropClone(sessionId);
  }
});

test("the person picks the days in Ajustes and the choice is kept", async ({ context, page }) => {
  // Kills: the select doing nothing on a press, or the action not reaching the person's metadata.
  const { userId } = readScope();
  const { session, sessionId } = await cloneSession(userId);

  try {
    await signInAs(context, session);
    await page.goto("/es/settings");

    const select = page.getByRole("combobox", { name: es.session.label });
    await expect(select).toContainText(es.session.always);
    await select.click();
    await page.getByRole("option", { name: /30/ }).click();

    await expect(select).toContainText(/30/);
    await expect
      .poll(async () => {
        const [row] = await fixtureSql<{ days: string | null }[]>`
          select raw_user_meta_data->>'keep_signed_in_days' as days from auth.users where id = ${userId}`;
        return row.days;
      })
      .toBe("30");

    await page.reload();
    await expect(page.getByRole("combobox", { name: es.session.label })).toContainText(/30/);
  } finally {
    await setKeepDays(userId, null);
    await dropClone(sessionId);
  }
});
