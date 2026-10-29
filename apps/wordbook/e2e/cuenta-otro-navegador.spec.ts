import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import type { Page } from "@playwright/test";
import postgres from "postgres";

import { closeRun, openRun } from "@repo/harness-registry";

import messages from "../messages/es.json";
import { expect, test } from "./fixtures";

// The session enters through the harness, never through /cuenta's form.
try {
  process.loadEnvFile(path.join(__dirname, "../.env.local"));
} catch {
  // No .env.local: whatever the shell already exported.
}

type Reader = { id: string; email: string };

async function landToken(sql: postgres.Sql, reader: Reader): Promise<string> {
  const hash = randomBytes(32).toString("hex");
  await sql`
    update auth.users
    set recovery_token = ${hash}, recovery_sent_at = now(), updated_at = now()
    where id = ${reader.id}`;
  await sql`
    insert into auth.one_time_tokens
      (id, user_id, token_type, token_hash, relates_to, created_at, updated_at)
    values
      (${randomUUID()}, ${reader.id}, 'recovery_token', ${hash}, ${reader.email}, now(), now())`;
  return hash;
}

async function mintReader(sql: postgres.Sql, runId: string): Promise<Reader> {
  const id = randomUUID();
  const email = `harness-reader-${id}@example.invalid`;
  await sql.begin(async (tx) => {
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
  return { id, email };
}

async function signInWith(page: Page, hash: string): Promise<void> {
  const response = await page.request.get(`/auth/confirm?token_hash=${hash}&type=magiclink`, {
    maxRedirects: 0,
  });
  const location = response.headers()["location"];
  expect(location?.includes("error="), `redirected to ${location ?? "nowhere"}`).toBe(false);
}

// A reader signed in on this page's context, torn down afterwards.
async function withReader(
  page: Page,
  body: (ctx: { sql: postgres.Sql; reader: Reader; signIn: () => Promise<void> }) => Promise<void>,
): Promise<void> {
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, {
    prepare: false,
    max: 1,
  });
  const runId = await openRun("e2e", sql);
  const reader = await mintReader(sql, runId);
  try {
    await body({
      sql,
      reader,
      signIn: async () => signInWith(page, await landToken(sql, reader)),
    });
  } finally {
    await sql`delete from harness.identities where user_id = ${reader.id}`;
    await sql`delete from auth.users where id = ${reader.id}`;
    await closeRun(sql);
    await sql.end();
  }
}

// RL-69 (PKCE): a link only enters the browser that asked for it. The title
// is the approved board's (CuentaEnlaceOtroNavegador), written out so the test
// does not agree with whatever the message file holds; the bodies are read
// from the catalog, which `catalog.test.ts` pins.
const OTHER_BROWSER_TITLE = "Abre el enlace en el navegador donde lo pediste";
const OTHER_BROWSER_BODY = messages.account.errors.linkOtherBrowserBody;
const SIGNED_IN_BODY = messages.account.errors.linkOtherBrowserSignedInBody;

test("RL-69: ?error=linkOtherBrowser draws its own notice, and neither of RL-49's", async ({ page }) => {
  await page.goto("/cuenta?error=linkOtherBrowser");

  await expect(page.getByText(OTHER_BROWSER_TITLE, { exact: true })).toBeVisible();
  await expect(page.getByText(OTHER_BROWSER_BODY, { exact: true })).toBeVisible();
  await expect(page.getByText(SIGNED_IN_BODY, { exact: true })).toHaveCount(0);
  await expect(page.getByText(messages.account.errors.linkInvalidTitle)).toHaveCount(0);
  await expect(page.getByText(messages.account.errors.linkTimeoutTitle)).toHaveCount(0);
  // No button of its own: the form below is the retry.
  await expect(page.getByRole("textbox", { name: messages.account.emailLabel })).toBeVisible();
});

test("an unknown ?error value draws no notice at all", async ({ page }) => {
  await page.goto("/cuenta?error=bogus");

  await expect(page.getByRole("textbox", { name: messages.account.emailLabel })).toBeVisible();
  for (const text of [
    OTHER_BROWSER_TITLE,
    messages.account.errors.linkInvalidTitle,
    messages.account.errors.linkTimeoutTitle,
  ]) {
    await expect(page.getByText(text)).toHaveCount(0);
  }
});

test("RL-69: with a session open the body says the session is here, and points at no form below", async ({ page }) => {
  await withReader(page, async ({ reader, signIn }) => {
    await signIn();
    await page.goto("/cuenta?error=linkOtherBrowser");

    await expect(page.getByText(OTHER_BROWSER_TITLE, { exact: true })).toBeVisible();
    await expect(page.getByText(SIGNED_IN_BODY, { exact: true })).toBeVisible();
    await expect(page.getByText(OTHER_BROWSER_BODY, { exact: true })).toHaveCount(0);
    await expect(page.getByText("aquí abajo")).toHaveCount(0);
    // Below the notice, the signed-in screen as it is.
    await expect(page.getByText(reader.email).first()).toBeVisible();
    await expect(page.getByRole("textbox", { name: messages.account.emailLabel })).toHaveCount(0);
  });
});
