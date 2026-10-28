import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { closedMonthMarkDay } from "@/lib/plan/closed-month-marks";
import { mondaysTouching } from "@/lib/day/habit-weeks";
import { weekHref } from "@/lib/day/week-href";
import { monthOf, nextMonth, previousMonth } from "@/lib/plan/months";
import { civilDayMonthShort, todayInZone, weekOf } from "@/lib/zone";
import { noOverflow } from "./mover-nota-ayuda";

// RP-142 on «Mes»: ‹ › step a month at a time, back to the month the first
// goal was opened and forward to the last month of the furthest goal's span.
// A coming month marks its tasks as this one does and lists after it what
// waits with no day; a past month reads as it was lived and marks nothing.
// The `person` is the worker's own, so the goals seeded here set both bounds.

const NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

const today = todayInZone();
const thisMonth = monthOf(today);
const lastMonth = previousMonth(thisMonth);
const comingMonth = nextMonth(thisMonth);
// The goal ends on the first of the month after the one after next: that one is the last.
const limitMonth = nextMonth(comingMonth);
const key = (month: string) => month.slice(0, 7);

// «Noviembre», or «Enero 2027» in another year.
function title(month: string): string {
  const name = NAMES[Number(month.slice(5, 7)) - 1];
  const capital = name.charAt(0).toUpperCase() + name.slice(1);
  return month.slice(0, 4) === today.slice(0, 4) ? capital : `${capital} ${month.slice(0, 4)}`;
}

type Seeded = { goalIds: string[]; looseId: string; stamp: number };

async function seed(db: postgres.Sql, person: Person): Promise<Seeded> {
  const stamp = Date.now();
  const opened = `${key(lastMonth)}-15T17:00:00Z`;
  const [english] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${`Inglés ${stamp}`}, ${nextMonth(limitMonth)}::date, 'minutos', 'minutos', ${opened})
    returning id
  `;
  // Ends on the first of next month: open this month, gone from the next.
  const [moving] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`Mudanza ${stamp}`}, ${comingMonth}::date, ${opened}) returning id
  `;
  await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${english.id}, ${comingMonth}::date, 300)`;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${english.id}, ${`Clase ${stamp}`}, ${comingMonth}::date, 60)
  `;
  const [done] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${english.id}, ${`Hecha ${stamp}`}, ${lastMonth}::date, 30) returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${person.id}, ${english.id}, ${done.id}, ${`${key(lastMonth)}-20`}::date)
  `;
  const [loose] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, name) values (${person.id}, ${`Suelta ${stamp}`}) returning id
  `;
  return { goalIds: [english.id, moving.id], looseId: loose.id, stamp };
}

async function withMonths(
  browser: Browser,
  baseURL: string | undefined,
  db: postgres.Sql,
  person: Person,
  width: number,
  run: (page: Page, seeded: Seeded) => Promise<void>,
) {
  const seeded = await seed(db, person);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 900 });
    await run(page, seeded);
  } finally {
    await context.close();
    await db`delete from goals.one_offs where id = ${seeded.looseId}`;
    await db`delete from goals.goals where id in ${db(seeded.goalIds)}`;
  }
}

const prev = (page: Page) => page.getByRole("link", { name: "Mes anterior" });
const next = (page: Page) => page.getByRole("link", { name: "Mes siguiente" });

for (const width of [390, 1280]) {
  test(`at ${width} › leads to next month: its plan, its placed task marked in one tap, a goal ended before it gone, «Sin día» (RP-142)`, async ({
    browser,
    baseURL,
    db,
    person,
  }) => {
    await withMonths(browser, baseURL, db, person, width, async (page, { stamp }) => {
      await page.goto("/mes");
      await next(page).click();
      await expect(page).toHaveURL(new RegExp(`/mes\\?mes=${key(comingMonth)}$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title(comingMonth));
      await expect(page.getByText("el plan de ese mes", { exact: true }).locator("visible=true")).toHaveCount(1);
      await expect(prev(page)).toHaveAttribute("href", "/mes");

      const english = page.locator("section", { has: page.getByRole("heading", { name: `Inglés ${stamp}` }) });
      // A month not yet lived says its plan alone, never a reached figure that can only be zero.
      const card = (await english.innerText()).replace(/\s+/g, " ");
      expect(card).toContain(`Plan de 5 h para ${NAMES[Number(comingMonth.slice(5, 7)) - 1]}`);
      expect(card).not.toMatch(/\b0 min\b/);
      await expect(page.getByRole("heading", { name: `Mudanza ${stamp}` })).toHaveCount(0);

      await page.getByRole("button", { name: `Marcar hecha: Clase ${stamp}` }).click();
      await expect(page.getByRole("button", { name: `Deshacer: Clase ${stamp}` })).toBeVisible({ timeout: 5000 });

      await expect(page.getByRole("button", { name: `Darle día a Suelta ${stamp}` })).toBeVisible();
      // The month's own task is drawn once, in its plan, never again under «Sin día».
      await expect(page.getByRole("button", { name: `Darle día a Clase ${stamp}` })).toHaveCount(0);
    });
  });
}

test("«Darle día» on a coming month proposes the month's first day (RP-142, RP-59)", async ({ browser, baseURL, db, person }) => {
  await withMonths(browser, baseURL, db, person, 390, async (page, { stamp }) => {
    await page.goto(`/mes?mes=${key(comingMonth)}`);
    await page.getByRole("button", { name: `Darle día a Suelta ${stamp}` }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("radio", { name: "otro día" })).toBeChecked();
    await expect(sheet.getByLabel("qué día")).toHaveValue(comingMonth);
  });
});

test("‹ leads to last month, the first one: its tasks as they stood, marked only within a fact's reach, no further ‹ (RP-142, RP-143)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  await withMonths(browser, baseURL, db, person, 390, async (page, { stamp }) => {
    await page.goto("/mes");
    await prev(page).click();
    await expect(page).toHaveURL(new RegExp(`/mes\\?mes=${key(lastMonth)}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title(lastMonth));
    await expect(page.getByText("el primero", { exact: true }).locator("visible=true")).toHaveCount(1);
    await expect(prev(page)).toHaveCount(0);
    await expect(next(page)).toHaveAttribute("href", "/mes");

    const english = page.locator("section", { has: page.getByRole("heading", { name: `Inglés ${stamp}` }) });
    await expect(english.getByText(`Hecha ${stamp}`, { exact: true })).toBeVisible();
    await expect(english.getByText("hecha", { exact: true })).toBeVisible();
    const marks = page.getByRole("button", { name: /^(Marcar hecha|Deshacer): / });
    if (closedMonthMarkDay(lastMonth, today) === null) await expect(marks).toHaveCount(0);
    else await expect(page.getByRole("button", { name: `Deshacer: Hecha ${stamp}` })).toBeVisible();
  });
});

test("the last month of the span has no ›; past it lands on it, before the first on the first, malformed on /mes (RP-142)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  await withMonths(browser, baseURL, db, person, 390, async (page) => {
    await page.goto(`/mes?mes=${key(limitMonth)}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title(limitMonth));
    await expect(next(page)).toHaveCount(0);
    const lands: [string, RegExp][] = [
      [key(nextMonth(limitMonth)), new RegExp(`/mes\\?mes=${key(limitMonth)}$`)],
      [key(previousMonth(lastMonth)), new RegExp(`/mes\\?mes=${key(lastMonth)}$`)],
      ["nada", /\/mes$/],
    ];
    for (const [param, url] of lands) {
      await page.goto(`/mes?mes=${param}`);
      await expect(page).toHaveURL(url);
    }
  });
});

test("«Semanas» under the month's header opens each week it touches; this week is /semana (RP-145)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  await withMonths(browser, baseURL, db, person, 390, async (page) => {
    await page.goto("/mes");
    const mondays = mondaysTouching(thisMonth);
    const links = page.getByRole("link", { name: /^Semana del / });
    await expect(links).toHaveCount(mondays.length);
    await expect(page.getByText("Semanas", { exact: true })).toBeVisible();
    const thisMonday = weekOf(todayInZone())[0];
    for (const [i, monday] of mondays.entries()) {
      await expect(links.nth(i)).toHaveAccessibleName(`Semana del ${civilDayMonthShort(monday)}`);
      await expect(links.nth(i)).toHaveAttribute("href", weekHref(monday, thisMonday));
    }
    await page.goto(`/mes?mes=${key(comingMonth)}`);
    // Its second week: the first may still be this one.
    const second = mondaysTouching(comingMonth)[1];
    await noOverflow(page, 390);
    await page.getByRole("link", { name: `Semana del ${civilDayMonthShort(second)}`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/semana\\?semana=${second}$`));
  });
});
