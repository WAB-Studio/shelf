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

// RL-52: the confirm POST answers 409 `reader` (the session belongs to another reader). The route is
// faked; nothing is typed into the form. This pins what the panel draws today, measured: the identity
// is dropped, no failure line is drawn, and neither the confirm button nor the retired state returns.
test("RL-52: a 409 reader on the confirm round draws today's panel: no failure line, no retired state", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await withReader(page, async ({ reader, signIn }) => {
    await signIn();
    await page.route("**/api/log/sync", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "reader" }),
      }),
    );
    await page.goto("/cuenta");
    await expect(page.getByText(`Copiar tu registro a ${reader.email}`)).toBeVisible();
    await page.getByRole("button", { name: messages.account.copy.confirmAction }).click();

    await expect(page.getByText(messages.account.copy.neverSynced)).toBeVisible();
    await expect(page.getByText(messages.account.copy.failedTitle)).toHaveCount(0);
    await expect(page.getByText(messages.account.copy.retiredTitle)).toHaveCount(0);
    await expect(page.getByRole("button", { name: messages.account.copy.confirmAction })).toHaveCount(0);
  });
});
