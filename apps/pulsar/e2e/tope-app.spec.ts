import type postgres from "postgres";

import { appAlerts, test, expect } from "./fixtures";
import chat from "../messages/es/chat.json";
import messages from "../messages/es/import.json";

// RP-126, against `PULSAR_FAULT_BASE_URL` (stubbed model and chat: nothing reaches OpenAI). The app's day
// is spent by seeding rows up to `APP_MODEL_CALLS_DAILY_CAP`'s default, 350. That count is every person's, so
// while these rows stand every other spec's claim is refused: the `tope-app` project runs after `fuente`
// finishes (`playwright.config.ts`), never beside it.
//
// The person's own caps are crossed too (the rows are theirs); the wording asked for is the app's. The route
// proofs (`scripts/plan/import-route.ts`, `chat-route.ts`) cover the person who is far under their own.

type Db = postgres.Sql;

const APP_DAY = 350;
const MARK = "RP-126 fixture";

async function spendTheAppsDay(db: Db, personId: string, source: "paste" | "chat"): Promise<void> {
  await db`
    insert into goals.model_calls (user_id, model, source, outcome)
    select ${personId}, ${MARK}, ${source}, 'ok'
    from generate_series(1, greatest(${APP_DAY} - (
      select count(*) from goals.model_calls where day = (now() at time zone 'America/Bogota')::date
    ), 1)::int)
  `;
}

async function giveBack(db: Db, personId: string): Promise<void> {
  await db`delete from goals.model_calls where user_id = ${personId} and model = ${MARK}`;
}

test.describe("the app's own day of model calls is spent (RP-126)", () => {
  test("the import says the limit is the app's and that it opens tomorrow; the person's own wording is not shown", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    await spendTheAppsDay(db, person.id, "paste");
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto("/metas/importar");
      await page.getByLabel(messages.textLabel).fill("Octubre: leer el capítulo uno. Noviembre: el dos.");
      await page.getByRole("button", { name: "Leer el plan" }).click();

      await expect(appAlerts(page).filter({ hasText: /\S/ })).toHaveText(messages.errors.capApp);
      await expect(page.getByText(messages.errors.cap, { exact: true })).toHaveCount(0);
      await expect(page.getByLabel(messages.upload)).toBeDisabled();
      await expect(page.getByRole("button", { name: "ver la plantilla" })).toBeVisible();
    } finally {
      await context.close();
      await giveBack(db, person.id);
    }
  });

  test("a plan written in the template still reads to the review", async ({ person, browser, baseURL, db }) => {
    await spendTheAppsDay(db, person.id, "paste");
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto("/metas/importar");
      await page.getByLabel(messages.textLabel).fill(messages.template.example);
      await page.getByRole("button", { name: "Leer el plan" }).click();
      await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
    } finally {
      await context.close();
      await giveBack(db, person.id);
    }
  });

  test("the chat says the limit is the app's and that it opens tomorrow; the field is shut", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    await spendTheAppsDay(db, person.id, "chat");
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 360, height: 740 } });
    try {
      const page = await context.newPage();
      await page.goto("/chat");
      await page.getByLabel(chat.field).fill("hola");
      await page.getByRole("button", { name: chat.send, exact: true }).click();

      await expect(page.getByText(chat.errors.capApp, { exact: true })).toBeVisible();
      await expect(page.getByText(chat.errors.cap, { exact: true })).toHaveCount(0);
      await expect(page.getByLabel(chat.field)).toBeDisabled();
    } finally {
      await context.close();
      await giveBack(db, person.id);
    }
  });
});
