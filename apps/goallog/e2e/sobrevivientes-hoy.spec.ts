import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// Hoy: every goal that
// ended this week gets its own line, and a row's second line reads in the
// order `HoyEscritorio.dc.html` and `HoyCuenta.dc.html` draw it: cadence,
// amount, count, hour, and the day it was written when that is not the day.
// Paths by day: Monday asserts both ended lines absent; Tuesday to Sunday draw them.

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

const today = todayInZone();
// 0 is Monday.
const todayIndex = (civilDateToDate(today).getUTCDay() + 6) % 7;
const isoWeekday = todayIndex + 1;
const WEEKDAYS_PLURAL = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábados", "domingos"];

// `goto` returns while the loading skeleton still stands.
async function settled(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator("main :is(h1, p, a, button, input)").first()).toBeVisible();
}

test("two goals ended this week draw one «terminó ayer · ver» line each", async ({ browser, baseURL, person, db }) => {
  // On a Monday yesterday was Sunday: its week is over, so no line draws.
  const drawn = todayIndex > 0;
  const stamp = Date.now();
  const first = `Terminada uno ${stamp}`;
  const second = `Terminada dos ${stamp}`;
  const openName = `Abierta ${stamp}`;
  const created = new Date(Date.now() - 60 * 86_400_000);
  const context = await browser.newContext({ baseURL: baseURL!, storageState: person.sessionFile });
  try {
    const [open] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, ${openName}, ${shift(today, 60)}, now() - interval '3 days') returning id
    `;
    // It asks something, or the phone draws no section for it (RP-47).
    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
      values (${person.id}, ${open.id}, ${`Tocar ${stamp}`}, 'daily', 'tap', now() - interval '3 days')
    `;
    for (const name of [first, second]) {
      await db`
        insert into goals.goals (user_id, name, horizon, created_at)
        values (${person.id}, ${name}, ${today}, ${created})
      `;
    }
    const page = await context.newPage();
    await page.goto("/");
    await settled(page);
    await expect(page.getByText(openName).first()).toBeVisible();
    await expect(page.getByText(`${first} terminó ayer`)).toHaveCount(drawn ? 1 : 0);
    await expect(page.getByText(`${second} terminó ayer`)).toHaveCount(drawn ? 1 : 0);
    await expect(page.getByText(/ terminó ayer/)).toHaveCount(drawn ? 2 : 0);
    for (const name of [first, second]) {
      await expect(page.getByRole("link", { name: `Abrir ${name}`, exact: true })).toHaveCount(drawn ? 1 : 0);
      await expect(page.getByRole("link", { name: `Abrir ${name}` }).filter({ hasText: /^ver$/ })).toHaveCount(drawn ? 1 : 0);
    }
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("a row's second line reads cadence, amount, count, hour, in that order", async ({ browser, baseURL, person, db }) => {
  const stamp = Date.now();
  const goalName = `Orden ${stamp}`;
  const context = await browser.newContext({ baseURL: baseURL!, storageState: person.sessionFile });
  try {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, ${goalName}, ${shift(today, 90)}, now() - interval '20 days') returning id
    `;
    // «solo los <hoy>», 10 minutos, done at 07:40.
    const [weekday] = await db<{ id: string }[]>`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, cadence_weekdays, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goal.id}, ${`Un día ${stamp}`}, 'weekdays', ${[isoWeekday]}, 'quantity', 10, 'minutos',
              now() - interval '20 days')
      returning id
    `;
    // The same, not yet done: cadence, then the target.
    await db`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, cadence_weekdays, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goal.id}, ${`Pendiente ${stamp}`}, 'weekdays', ${[isoWeekday]}, 'quantity', 20, 'páginas',
              now() - interval '20 days')
    `;
    // A flexible one: its count stands in for the cadence, after the amount.
    const [weekly] = await db<{ id: string }[]>`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, cadence_n, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goal.id}, ${`Semanal ${stamp}`}, 'times_per_week', 3, 'quantity', 10, 'minutos',
              now() - interval '20 days')
      returning id
    `;
    for (const id of [weekday.id, weekly.id]) {
      await db`
        insert into goals.facts (user_id, commitment_id, goal_id, day, quantity, written_at)
        values (${person.id}, ${id}, ${goal.id}, ${today}, 10, ${`${today}T07:40:00-05:00`})
      `;
    }
    const plural = WEEKDAYS_PLURAL[isoWeekday - 1];

    const page = await context.newPage();
    await page.goto("/");
    await settled(page);
    await expect(page.getByText(`Un día ${stamp}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`solo los ${plural} · 10 min`, { exact: true })).toBeVisible();
    await expect(page.getByText(`solo los ${plural} · 20 páginas`, { exact: true })).toBeVisible();
    await expect(page.getByText("10 min · 1 de 3 esta semana", { exact: true })).toBeVisible();

    // Written another day than the one on the page: the day closes the line.
    const yesterday = shift(today, -1);
    const [past] = await db<{ id: string }[]>`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goal.id}, ${`Ayer ${stamp}`}, 'daily', 'quantity', 5, 'minutos', now() - interval '20 days')
      returning id
    `;
    await db`
      insert into goals.facts (user_id, commitment_id, goal_id, day, quantity, written_at)
      values (${person.id}, ${past.id}, ${goal.id}, ${yesterday}, 5, ${`${today}T07:40:00-05:00`})
    `;
    await page.goto(`/dia/${yesterday}`);
    await settled(page);
    await expect(page.getByText(/^todos los días · 5 min · anotado el /)).toBeVisible();
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});
