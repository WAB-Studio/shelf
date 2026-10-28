import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { lastMondayOf } from "@/lib/plan/forward-limit";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// RP-142 on Semana: › steps past this week to the last week of the furthest
// open goal's span. A coming week draws what each day will ask with no mark and
// the tasks dated in it; in it only «Darle día» acts. The `person` is the
// worker's own, so the goal seeded here is the one that sets the limit.

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

const mondayOf = (day: string) => shift(day, -((civilDateToDate(day).getUTCDay() + 6) % 7));

function longName(day: string): string {
  const date = civilDateToDate(day);
  const weekday = new Intl.DateTimeFormat("es", { weekday: "long", timeZone: "UTC" }).format(date);
  return `${weekday} ${date.getUTCDate()}`;
}

const today = todayInZone();
const thisMonday = mondayOf(today);
const nextMonday = shift(thisMonday, 7);
// The third of the month after next: the goal's span ends early in the limit
// month, so the last weeks › reaches ask nothing of it.
const HORIZON = `${nextMonth(nextMonth(monthOf(today))).slice(0, 7)}-03`;
// The goal's last day falls in the limit month; the week holding that month's end is the last one.
const lastMonday = lastMondayOf(shift(HORIZON, -1).slice(0, 7));

const GOAL = "Correr la media";
const COMMITMENT = "Trotar";
const DATED = "Llamar al banco";
const DAYLESS = "Comprar tenis";
const ARCHIVED = "Meta dejada";
const ARCHIVED_TASK = "Pagar la inscripción";
const datedDay = shift(nextMonday, 2);

// Noon Bogotá on the civil day: the same civil day in every zone near it.
function noonOf(day: string): Date {
  return new Date(`${day}T17:00:00Z`);
}

async function seed(db: postgres.Sql, person: Person) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${GOAL}, ${HORIZON}, ${noonOf(shift(today, -10))}) returning id
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${person.id}, ${goal.id}, ${COMMITMENT}, 'daily', 'tap', ${noonOf(shift(today, -10))})
  `;
  await db`insert into goals.one_offs (user_id, goal_id, name, day) values (${person.id}, ${goal.id}, ${DATED}, ${datedDay})`;
  const [dayless] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, name) values (${person.id}, ${DAYLESS}) returning id
  `;
  const [archived] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at, archived_at)
    values (${person.id}, ${ARCHIVED}, ${HORIZON}, ${noonOf(shift(today, -10))}, ${noonOf(shift(today, -1))}) returning id
  `;
  await db`insert into goals.one_offs (user_id, goal_id, name, day) values (${person.id}, ${archived.id}, ${ARCHIVED_TASK}, ${datedDay})`;
  return { goalIds: [goal.id, archived.id], daylessId: dayless.id };
}

async function withComing(
  browser: Browser,
  baseURL: string | undefined,
  db: postgres.Sql,
  person: Person,
  width: number,
  run: (page: Page) => Promise<void>,
) {
  const { goalIds, daylessId } = await seed(db, person);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 900 });
    await run(page);
  } finally {
    await context.close();
    await db`delete from goals.one_offs where id = ${daylessId}`;
    await db`delete from goals.goals where id in ${db(goalIds)}`;
  }
}

const next = (page: Page) => page.getByRole("link", { name: "Semana siguiente" });
const giveDay = (page: Page, name: string) => page.getByRole("button", { name: `Darle día a ${name}` });

for (const width of [390, 1440]) {
  test(`at ${width} › leads to next week: its asks with no mark, the task dated in it, «Sin día», and no day opens (RP-142)`, async ({
    browser,
    baseURL,
    db,
    person,
  }) => {
    await withComing(browser, baseURL, db, person, width, async (page) => {
      await page.goto("/semana");
      await next(page).click();
      await expect(page).toHaveURL(new RegExp(`/semana\\?semana=${nextMonday}$`));
      await expect(page.getByText("la semana que viene", { exact: true }).locator("visible=true")).toHaveCount(1);

      const marks = page.getByRole("img", { name: new RegExp(`^${COMMITMENT}, `) }).locator("visible=true");
      await expect(marks).toHaveCount(7);
      for (const mark of await marks.all()) await expect(mark).not.toHaveAttribute("data-state", "declared");

      await expect(page.getByRole("link", { name: /^Abrir el (?!chat$)/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: `Mover ${DATED} a otro día` })).toContainText(longName(datedDay));
      // A task of a goal archived since is no task of the weeks to come.
      await expect(page.getByText(ARCHIVED_TASK)).toHaveCount(0);
      await expect(giveDay(page, DAYLESS)).toBeVisible();
    });
  });
}

test("«Darle día» on a coming week moves the task from «Sin día» to its day with no reload; cancelled it stays (RP-142, RP-59)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  await withComing(browser, baseURL, db, person, 390, async (page) => {
    await page.goto(`/semana?semana=${nextMonday}`);
    // A full reload would drop this mark; a refresh of the route keeps it.
    await page.evaluate(() => Object.assign(window, { stayed: true }));

    await giveDay(page, DAYLESS).click();
    await page.getByRole("dialog").getByRole("button", { name: "Dejarla sin día" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(giveDay(page, DAYLESS)).toBeVisible();

    const thursday = shift(nextMonday, 3);
    await giveDay(page, DAYLESS).click();
    const sheet = page.getByRole("dialog");
    // The sheet proposes the week's own Monday, never today.
    await expect(sheet.getByRole("radio", { name: "otro día" })).toBeChecked();
    await expect(sheet.getByLabel("qué día")).toHaveValue(nextMonday);
    await sheet.getByLabel("qué día").fill(thursday);
    await sheet.getByRole("button", { name: "Ponerle ese día" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(giveDay(page, DAYLESS)).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Mover ${DAYLESS} a otro día` })).toContainText(longName(thursday));
    expect(await page.evaluate(() => "stayed" in window)).toBe(true);
  });
});

test("two weeks out reads «dentro de 2 semanas» and, with nothing dated, the empty sentence (RP-142)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  test.skip(shift(nextMonday, 7) > lastMonday, "the goal's span ends before the week after next");
  await withComing(browser, baseURL, db, person, 390, async (page) => {
    await page.goto(`/semana?semana=${shift(nextMonday, 7)}`);
    await expect(page.getByText("dentro de 2 semanas", { exact: true }).locator("visible=true")).toHaveCount(1);
    await expect(page.getByText("Nada tiene día en esta semana todavía.")).toBeVisible();
  });
});

test("the last week of the limit month has no ›, past the goal's end it asks nothing, and the week after it lands on /semana (RP-142)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  await withComing(browser, baseURL, db, person, 390, async (page) => {
    await page.goto(`/semana?semana=${lastMonday}`);
    await expect(page).toHaveURL(new RegExp(`/semana\\?semana=${lastMonday}$`));
    await expect(next(page)).toHaveCount(0);
    await expect(page.getByText("Ninguna meta pide algo esta semana.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Crear una meta" })).toHaveCount(0);
    await page.goto(`/semana?semana=${shift(lastMonday, 7)}`);
    await expect(page).toHaveURL(/\/semana$/);
  });
});

test("this week is no coming week: its marks act, it lists no «con día» and offers no «Darle día» (RP-142)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  await withComing(browser, baseURL, db, person, 390, async (page) => {
    await page.goto("/semana");
    await expect(page.getByText("esta semana", { exact: true }).locator("visible=true")).toHaveCount(1);
    await expect(giveDay(page, DAYLESS)).toHaveCount(0);
    await expect(page.getByText("con día", { exact: true })).toHaveCount(0);
  });
});
