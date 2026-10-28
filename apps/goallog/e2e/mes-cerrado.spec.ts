import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { closedMonthMarkDay } from "@/lib/plan/closed-month-marks";
import { monthOf, previousMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// RP-143: a closed month still marks its tasks for seven days, dated its last day; from the eighth
// it reads only, on «Mes» and on the goal's own month page. The server reads the real day, so the
// marking side runs only on the first seven days of a month; the read-only side runs every day on
// the month before last, always past the reach.

const today = todayInZone();
const lastMonth = previousMonth(monthOf(today));
const monthBefore = previousMonth(lastMonth);
const key = (month: string) => month.slice(0, 7);
const lastMarkDay = closedMonthMarkDay(lastMonth, today);

type Seeded = { goalId: string; stamp: number };

async function seed(db: postgres.Sql, person: Person): Promise<Seeded> {
  const stamp = Date.now();
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, created_at)
    values (${person.id}, ${`Casa ${stamp}`}, ${`${key(previousMonth(monthBefore))}-15T17:00:00Z`}) returning id
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values
      (${person.id}, ${goal.id}, ${`Pintar ${stamp}`}, ${monthBefore}::date),
      (${person.id}, ${goal.id}, ${`Barrer ${stamp}`}, ${lastMonth}::date)
  `;
  return { goalId: goal.id, stamp };
}

async function withClosed(
  browser: Browser,
  baseURL: string | undefined,
  db: postgres.Sql,
  person: Person,
  run: (page: Page, seeded: Seeded) => Promise<void>,
) {
  const seeded = await seed(db, person);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 900 });
    await run(page, seeded);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${seeded.goalId}`;
  }
}

const marks = (page: Page) => page.getByRole("button", { name: /^(Marcar como hecho|Marcar hecha|Deshacer): / });

test("past the reach, the goal's month page shows its task with no mark and no sheet, and «Mes» says how it stood (RP-143)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  await withClosed(browser, baseURL, db, person, async (page, { goalId, stamp }) => {
    await page.goto(`/metas/${goalId}/meses/${key(monthBefore)}`);
    await expect(page.getByText(`Pintar ${stamp}`, { exact: true })).toBeVisible();
    await expect(marks(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: new RegExp(`Pintar ${stamp}`) })).toHaveCount(0);
    await page.getByText(`Pintar ${stamp}`, { exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.goto(`/mes?mes=${key(monthBefore)}`);
    await expect(page.getByText(`Pintar ${stamp}`, { exact: true })).toBeVisible();
    await expect(page.getByText("sin hacer", { exact: true })).toBeVisible();
    await expect(marks(page)).toHaveCount(0);
  });
});

test("within the reach, last month's task marks on both pages and its fact is dated the month's last day (RP-143)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  test.skip(lastMarkDay === null, "last month is past a fact's reach from the eighth day on");
  await withClosed(browser, baseURL, db, person, async (page, { goalId, stamp }) => {
    await page.goto(`/mes?mes=${key(lastMonth)}`);
    await page.getByRole("button", { name: `Marcar hecha: Barrer ${stamp}` }).click();
    await expect(page.getByRole("button", { name: `Deshacer: Barrer ${stamp}` })).toBeVisible();
    const [fact] = await db<{ day: string }[]>`
      select f.day::text as day from goals.facts f join goals.one_offs o on o.id = f.one_off_id
      where o.goal_id = ${goalId}`;
    expect(fact.day).toBe(lastMarkDay);

    await page.goto(`/metas/${goalId}/meses/${key(lastMonth)}`);
    await page.getByRole("button", { name: `Deshacer: Barrer ${stamp}` }).click();
    await expect(page.getByRole("button", { name: `Marcar como hecho: Barrer ${stamp}` })).toBeVisible();
  });
});
