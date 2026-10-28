import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { NAMES } from "./mes-siguiente-seed";
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

type Seeded = { goalId: string; archivedId: string; bareId: string; endedId: string; habitId: string; stamp: number };

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
  // A parent of the month before last: one sub-task done in it, one done only today.
  const [parent] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${person.id}, ${goal.id}, ${`Mudar ${stamp}`}, ${monthBefore}::date) returning id
  `;
  const [inMonth, later] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, parent_id, name)
    values (${person.id}, ${goal.id}, ${parent.id}, ${`Empacar ${stamp}`}), (${person.id}, ${goal.id}, ${parent.id}, ${`Cargar ${stamp}`})
    returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${person.id}, ${goal.id}, ${inMonth.id}, ${`${key(monthBefore)}-10`}::date), (${person.id}, ${goal.id}, ${later.id}, ${today}::date)
  `;
  // A loose weekly habit: a closed month reads no «esta semana» tally.
  const [habit] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, satisfaction, created_at)
    values (${person.id}, null, ${`Nadar ${stamp}`}, 'times_per_week', 3, 'tap', ${`${key(previousMonth(monthBefore))}-15T17:00:00Z`})
    returning id
  `;
  // Archived today: the month before last still draws it, as it was lived.
  const [archived] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, created_at, archived_at)
    values (${person.id}, ${`Huerta ${stamp}`}, ${`${key(previousMonth(monthBefore))}-15T17:00:00Z`}, now()) returning id
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${person.id}, ${archived.id}, ${`Sembrar ${stamp}`}, ${monthBefore}::date)
  `;
  // A goal with no task: an open month would offer it «Añadir una tarea».
  const [bare] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, created_at)
    values (${person.id}, ${`Lectura ${stamp}`}, ${`${key(previousMonth(monthBefore))}-15T17:00:00Z`}) returning id
  `;
  // A goal that ended with the month before last: what it left undone goes nowhere.
  const [ended] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`Viaje ${stamp}`}, ${lastMonth}::date, ${`${key(previousMonth(monthBefore))}-15T17:00:00Z`}) returning id
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${person.id}, ${ended.id}, ${`Reservar ${stamp}`}, ${monthBefore}::date)
  `;
  return { goalId: goal.id, archivedId: archived.id, bareId: bare.id, endedId: ended.id, habitId: habit.id, stamp };
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
    await db`delete from goals.commitments where id = ${seeded.habitId}`;
    await db`delete from goals.goals where id in (${seeded.goalId}, ${seeded.archivedId}, ${seeded.bareId}, ${seeded.endedId})`;
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
    await expect(marks(page)).toHaveCount(0);
    // How each stood at the month's close: a sub-task done after it reads «sin hacer».
    const stood = (name: string) =>
      page.getByText(name, { exact: true }).locator("xpath=following-sibling::*[1]");
    // Undone, an open goal's task carries on into the next month; its sub-task reads «sin hacer».
    await expect(stood(`Pintar ${stamp}`)).toHaveText(`sigue en ${NAMES[Number(lastMonth.slice(5, 7)) - 1]}`);
    await expect(stood(`Empacar ${stamp}`)).toHaveText("hecha");
    await expect(stood(`Cargar ${stamp}`)).toHaveText("sin hacer");
    // A parent reads as its own month page does, never «sigue en».
    await expect(stood(`Mudar ${stamp}`)).toHaveText("sin hacer");
    await expect(stood(`Reservar ${stamp}`)).toHaveText("sin hacer");
    // A goal archived since carries nothing on.
    await expect(stood(`Sembrar ${stamp}`)).toHaveText("sin hacer");
    await expect(page.getByText(`Nadar ${stamp}`, { exact: true })).toBeVisible();
    await expect(page.getByText(/esta semana/)).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^(Añadir una tarea|Planear )/ })).toHaveCount(0);
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
