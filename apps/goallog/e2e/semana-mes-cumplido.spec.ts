import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";

// «N al mes» counts its month, not the week on screen: a commitment whose
// month is met asks nothing on the days after (as Hoy already reads it), so
// Semana draws no mark on them. Seeded relative to the month of the run;
// a row the calendar forbids today is skipped with its reason.

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

function addDays(day: string, days: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

function dayOfMonth(day: string): number {
  return Number(day.slice(8, 10));
}

function priorMonthOf(day: string): string {
  const [year, month] = day.split("-").map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

type Db = postgres.Sql;

async function seedGoal(db: Db, personId: string, name: string): Promise<string> {
  const [goal] = await db`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${name}, ${addDays(todayInZone(), 90)}::date, now() - interval '70 days') returning id
  `;
  return goal.id as string;
}

async function seedMonthly(
  db: Db,
  personId: string,
  goalId: string,
  name: string,
  quota: number,
  days: string[],
): Promise<void> {
  const [row] = await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, satisfaction, created_at)
    values (${personId}, ${goalId}, ${name}, 'times_per_month', ${quota}, 'tap', now() - interval '70 days') returning id
  `;
  for (const day of days) {
    await db`
      insert into goals.facts (user_id, goal_id, commitment_id, day)
      values (${personId}, ${goalId}, ${row.id}, ${day}::date)
    `;
  }
}

// What the row draws, by the accessible name each cell carries.
function marks(page: Page, name: string, status: string) {
  return page.getByRole("img", { name: new RegExp(`^${name}, .*: ${status}$`) });
}

async function expectRow(page: Page, name: string, done: number) {
  await expect(page.getByRole("img", { name: new RegExp(`^${name}, `) })).toHaveCount(7);
  await expect(marks(page, name, "hecho")).toHaveCount(done);
  await expect(marks(page, name, "no pedía")).toHaveCount(7 - done);
}

test("the screen draws what the query asks: the tap after the met quota is «hecho», the days it does not ask are «no pedía» (phone and 1440)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const today = todayInZone();
  const monday = weekOf(today)[0];
  test.skip(
    monday.slice(0, 7) !== today.slice(0, 7) || dayOfMonth(monday) < 3,
    "the month's days 1 and 2 must fall before this week's Monday and inside this month; early in the month the calendar has no week to test",
  );
  const month = today.slice(0, 7);
  const name = `Cumplido ${Date.now()}`;
  const goalId = await seedGoal(db, person.id, `Meta mes cumplido ${Date.now()}`);
  // Two taps in the first days meet «2 al mes»; the third is this week's.
  // A declared fact is never hidden: it draws «hecho» though that day no longer asks.
  await seedMonthly(db, person.id, goalId, name, 2, [`${month}-01`, `${month}-02`, today]);

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    for (const size of VIEWPORTS) {
      await page.setViewportSize(size);
      await page.goto("/semana");
      await expect(page.locator("main")).toHaveCount(1);
      await expectRow(page, name, 1);
    }
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId}`;
  }
});

test("the week that holds the 1st counts each day against its own month (phone and 1440)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const today = todayInZone();
  const first = `${today.slice(0, 7)}-01`;
  const crossing = weekOf(first);
  test.skip(crossing[0] === first, "the 1st is a Monday: no week straddles two months this month");
  const lastOfPrior = addDays(first, -1);
  const name = `A caballo ${Date.now()}`;
  const goalId = await seedGoal(db, person.id, `Meta a caballo ${Date.now()}`);
  // «1 al mes»: the last day of the prior month met the prior month; the 1st
  // opens a month of its own and asks again.
  await seedMonthly(db, person.id, goalId, name, 1, [lastOfPrior, first]);

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    for (const size of VIEWPORTS) {
      await page.setViewportSize(size);
      await page.goto(`/semana?semana=${crossing[0]}`);
      await expect(page.locator("main")).toHaveCount(1);
      await expectRow(page, name, 2);
    }
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId}`;
  }
});

test("a past week keeps drawing a tap made after its month's quota was met (phone and 1440)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const lastMonth = priorMonthOf(todayInZone());
  const thirdWeek = weekOf(`${lastMonth}-15`);
  const name = `Pasado ${Date.now()}`;
  const goalId = await seedGoal(db, person.id, `Meta mes pasado ${Date.now()}`);
  await seedMonthly(db, person.id, goalId, name, 2, [`${lastMonth}-01`, `${lastMonth}-02`, `${lastMonth}-15`]);

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    for (const size of VIEWPORTS) {
      await page.setViewportSize(size);
      await page.goto(`/semana?semana=${thirdWeek[0]}`);
      await expect(page.locator("main")).toHaveCount(1);
      await expectRow(page, name, 1);
    }
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId}`;
  }
});

test("a task done last week of the same month is not drawn in this week", async ({ person, browser, baseURL, db }) => {
  const today = todayInZone();
  const monday = weekOf(today)[0];
  const lastWeekDay = addDays(monday, -1);
  test.skip(
    lastWeekDay.slice(0, 7) !== today.slice(0, 7),
    "the day before this week's Monday falls in the prior month: no earlier week of this month exists",
  );
  const stamp = Date.now();
  const taskName = `Suelta de la semana anterior ${stamp}`;
  const goalId = await seedGoal(db, person.id, `Meta sueltas ${stamp}`);
  // A met monthly commitment makes the goal draw a section this week.
  await seedMonthly(db, person.id, goalId, `Compromiso ${stamp}`, 1, [lastWeekDay]);
  const [oneOff] = await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${person.id}, ${goalId}, ${taskName}, ${`${today.slice(0, 7)}-01`}::date) returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${person.id}, ${goalId}, ${oneOff.id}, ${lastWeekDay}::date)
  `;

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    for (const size of VIEWPORTS) {
      await page.setViewportSize(size);
      await page.goto("/semana");
      await expect(page.locator("main")).toHaveCount(1);
      await expect(page.getByRole("img", { name: new RegExp(`^Compromiso ${stamp}, `) })).toHaveCount(7);
      await expect(page.getByText(taskName)).toHaveCount(0);
    }
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId}`;
  }
});
