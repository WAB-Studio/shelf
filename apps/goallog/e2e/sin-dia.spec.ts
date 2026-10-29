import type { Browser, Page } from "@playwright/test";

import { test, expect } from "./fixtures";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// «Sin día» on a coming week and a coming month (RP-59, RP-142): a goal's task with no day and no
// month waits there with «Darle día» in words; a task its plan already places in a month does not,
// and the month draws it once, in its own list. With nothing waiting, no «Sin día» is drawn.

const today = todayInZone();
const comingMonth = nextMonth(monthOf(today));
const key = (month: string) => month.slice(0, 7);

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}
const nextMonday = shift(today, 7 - ((civilDateToDate(today).getUTCDay() + 6) % 7));

const DAYLESS_GROUP = "sin día";

// The worker's own person, whose «Sin día» holds only what a test seeds.
async function asPerson(browser: Browser, baseURL: string | undefined, sessionFile: string, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ storageState: sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 900 });
    await run(page);
  } finally {
    await context.close();
  }
}

const giveDay = (page: Page, name: string) => page.getByRole("button", { name: `Darle día a ${name}` });

test("a goal's task with no day waits in «Sin día» with «Darle día»; one placed in a month waits nowhere but its month", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  const stamp = Date.now();
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`Taller ${stamp}`}, ${nextMonth(comingMonth)}::date, now() - interval '10 days') returning id
  `;
  const [, barnish] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${person.id}, ${goal.id}, ${`Lijar ${stamp}`}, null), (${person.id}, ${goal.id}, ${`Barnizar ${stamp}`}, ${comingMonth}::date)
    returning id
  `;
  // A sub-task with no month of its own: the month draws it under its parent, never again in «Sin día».
  await db`
    insert into goals.one_offs (user_id, goal_id, parent_id, name)
    values (${person.id}, ${goal.id}, ${barnish.id}, ${`Pulir ${stamp}`})
  `;
  try {
    await asPerson(browser, baseURL, person.sessionFile, async (page) => {
      await page.goto(`/semana?semana=${nextMonday}`);
      await expect(giveDay(page, `Lijar ${stamp}`)).toContainText("Darle día");
      await expect(giveDay(page, `Barnizar ${stamp}`)).toHaveCount(0);

      await page.goto(`/mes?mes=${key(comingMonth)}`);
      await expect(giveDay(page, `Lijar ${stamp}`)).toBeVisible();
      await expect(page.getByText(`Barnizar ${stamp}`, { exact: true })).toHaveCount(1);
      await expect(giveDay(page, `Barnizar ${stamp}`)).toHaveCount(0);
      await expect(page.getByText(`Pulir ${stamp}`, { exact: true })).toHaveCount(1);
      await expect(giveDay(page, `Pulir ${stamp}`)).toHaveCount(0);
    });
  } finally {
    await db`delete from goals.goals where id = ${goal.id}`;
  }
});

test("with nothing waiting, a coming week draws no «Sin día»", async ({ browser, baseURL, db, person }) => {
  const stamp = Date.now();
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`Taller ${stamp}`}, ${nextMonth(comingMonth)}::date, now() - interval '10 days') returning id
  `;
  try {
    await asPerson(browser, baseURL, person.sessionFile, async (page) => {
      await page.goto(`/semana?semana=${nextMonday}`);
      await expect(page.getByText("la semana que viene", { exact: true }).locator("visible=true")).toHaveCount(1);
      await expect(page.getByText(DAYLESS_GROUP, { exact: true })).toHaveCount(0);
    });
  } finally {
    await db`delete from goals.goals where id = ${goal.id}`;
  }
});
