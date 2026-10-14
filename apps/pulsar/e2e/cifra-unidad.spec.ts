import { randomBytes, randomUUID } from "node:crypto";

import type { BrowserContext } from "@playwright/test";
import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { dateToCivilDate, todayInZone } from "@/lib/zone";

// RP-14: the goal's total sums every fact in its unit, so the screens name the
// figure by that unit, never by the first commitment's name. Hoy's card
// (`HoyEscritorio.dc.html`), the goal's «mide en …» line and the review's header.
// The person is this spec's own and is dropped by id.

// Registered under the suite's run the way `mint-session.ts` registers the
// first person; the run's teardown drops it if this spec cannot.
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

// The real `/auth/confirm` redemption `mint-session.ts` performs, its cookies
// landing in this context's own jar.
async function signIn(context: BrowserContext, db: postgres.Sql, personId: string) {
  const hash = randomBytes(32).toString("hex");
  const [{ email }] = await db<{ email: string }[]>`
    update auth.users set recovery_token = ${hash}, recovery_sent_at = now(), updated_at = now()
    where id = ${personId} returning email`;
  await db`
    insert into auth.one_time_tokens (id, user_id, token_type, token_hash, relates_to, created_at, updated_at)
    values (${randomUUID()}, ${personId}, 'recovery_token', ${hash}, ${email}, now(), now())`;
  const response = await context.request.get(`/auth/confirm?token_hash=${hash}&type=magiclink`, {
    maxRedirects: 0,
  });
  const location = response.headers()["location"];
  if (!location || location.includes("error=")) {
    throw new Error(`/auth/confirm refused the token: ${location}`);
  }
}

async function dropPerson(db: postgres.Sql, id: string) {
  await db`delete from goals.facts where user_id = ${id}`;
  await db`delete from goals.one_offs where user_id = ${id}`;
  await db`delete from goals.goals where user_id = ${id}`;
  await db`delete from auth.users where id = ${id}`;
  await db`delete from harness.identities where user_id = ${id}`;
}

const KM = "kilómetros";
const FIRST = 6;
const SECOND = 14;

test("the week's figure carries its unit on Hoy, the goal and the review, and is the sum of both commitments (RP-14)", async ({
  browser,
  baseURL,
  db,
}) => {
  const personId = await createPerson(db);
  const context = await browser.newContext({ baseURL: baseURL! });
  const page = await context.newPage();
  await signIn(context, db, personId);
  const stamp = Date.now();
  const goalName = `Meta cifra ${stamp}`;
  const first = `Rodaje suave ${stamp}`;
  const second = `Tirada larga ${stamp}`;
  try {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${personId}, ${goalName}, ${dateToCivilDate(new Date(Date.now() + 60 * 86_400_000))}, ${KM}, ${KM}, ${new Date(Date.now() - 12 * 86_400_000)})
      returning id
    `;
    const commitmentIds: string[] = [];
    for (const [name, quantity] of [[first, FIRST], [second, SECOND]] as const) {
      const [row] = await db<{ id: string }[]>`
        insert into goals.commitments
          (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
        values (${personId}, ${goal.id}, ${name}, 'daily', 'quantity', 5, ${KM}, ${new Date(Date.now() - 12 * 86_400_000)})
        returning id
      `;
      commitmentIds.push(row.id);
      await db`
        insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
        values (${personId}, ${row.id}, ${goal.id}, ${todayInZone()}, ${quantity})
      `;
    }
    const total = String(FIRST + SECOND);

    await page.setViewportSize({ width: 1280, height: 800 });

    // Hoy: the card's label is the goal, its figure the sum in its unit, its caption the week.
    await page.goto("/");
    const card = page
      .getByText("esta semana", { exact: true })
      .locator("xpath=ancestor::div[.//a][1]")
      .filter({ hasText: goalName });
    await expect(card).toHaveCount(1);
    await expect(card.locator("[class*='section-label']").first()).toHaveText(goalName);
    await expect(card).toContainText(new RegExp(`${total}\\s*${KM}`));
    await expect(card).toContainText("esta semana");
    await expect(card).not.toContainText(first);
    await expect(card).not.toContainText(second);

    // The goal: the line leads with the unit; the figure is the sum.
    await page.goto(`/metas/${goal.id}`);
    await expect(page.getByText(`mide en ${KM}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`mide ${first}`)).toHaveCount(0);
    await expect(page.getByText(new RegExp(`^${total}\\s*${KM}`)).first()).toBeVisible();

    // The review: the unit heads the page, «total» the column, never the name.
    await page.goto(`/metas/${goal.id}/revision`);
    await expect(page.getByText(`mide en ${KM}`, { exact: true })).toHaveCount(1);
    await expect(page.locator("p", { hasText: first })).toHaveCount(0);
    const header = page.getByRole("columnheader").nth(1);
    await expect(header).toContainText("total");
    await expect(header).not.toContainText(first);
    await expect(page.getByRole("table").getByText(total, { exact: true }).first()).toBeVisible();
  } finally {
    await context.close();
    await dropPerson(db, personId);
  }
});
