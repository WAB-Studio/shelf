import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// RP-06 from the week (`Semana.dc.html`): a past day's label is the way into
// that day's own screen; today's is plain text, a future day's is too. Each
// test seeds its own goal, backdated so its commitment exists on every day
// of the week, and drops it by the id it got back. A Monday's week holds no
// past day: its run asserts no label is a link, every other run taps one.

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

// Monday is 0, as `weekOf` counts a week.
function weekdayIndex(day: string): number {
  return (civilDateToDate(day).getUTCDay() + 6) % 7;
}

// ICU's Spanish, never the catalogue's list the screen reads.
function openName(day: string): string {
  const date = civilDateToDate(day);
  const weekday = new Intl.DateTimeFormat("es", { weekday: "long", timeZone: "UTC" }).format(date);
  return `Abrir el ${weekday} ${date.getUTCDate()}`;
}

function longName(day: string): string {
  const date = civilDateToDate(day);
  const weekday = new Intl.DateTimeFormat("es", { weekday: "long", timeZone: "UTC" }).format(date);
  return `${weekday} ${date.getUTCDate()}`;
}

async function seedGoal(db: postgres.Sql, personId: string, name: string) {
  const stamp = Date.now();
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${`Meta semana pasada ${stamp}`}, ${shift(todayInZone(), 60)}, ${new Date(Date.now() - 12 * 86_400_000)}) returning id
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${personId}, ${goal.id}, ${name}, 'daily', 'tap', ${new Date(Date.now() - 12 * 86_400_000)})
  `;
  return goal.id;
}

async function deleteGoal(db: postgres.Sql, personId: string, goalId: string) {
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

const today = todayInZone();
const daysBack = weekdayIndex(today);
const weekDays = Array.from({ length: 7 }, (_, i) => shift(today, i - daysBack));
const pastDays = weekDays.filter((day) => day < today);
const futureDays = weekDays.filter((day) => day > today);

test("a past day of the week is a link to its own screen, today and a future day are not (RP-06)", async ({
  page,
  db,
  personId,
}) => {
  const goalId = await seedGoal(db, personId, `Compromiso semana ${Date.now()}`);
  try {
    await page.goto("/semana");
    await expect(page.getByText("Meta semana pasada").locator("visible=true").first()).toBeVisible();

    const links = page.getByRole("link", { name: /^Abrir el (?!chat$)/ });
    await expect(links).toHaveCount(pastDays.length);
    for (const day of pastDays) {
      await expect(page.getByRole("link", { name: openName(day) })).toHaveAttribute("href", `/dia/${day}`);
    }

    // Plain header cells, never a link: no `Abrir` names them.
    for (const day of [today, ...futureDays]) {
      await expect(page.getByRole("link", { name: openName(day) })).toHaveCount(0);
    }
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});

test("a tap on a past day from the week fills that day's dot on return (RP-06)", async ({ page, db, personId }) => {
  // The rule itself, every day of the week, is proven in
  // `lib/day/week-href.test.ts`; only the tap needs a past day to exist. A
  // Monday's week holds none: that run asserts no label is a way in.
  const name = `Compromiso semana ${Date.now()}`;
  const goalId = await seedGoal(db, personId, name);
  const day = pastDays.at(-1);

  try {
    await page.goto("/semana");
    const marks = page.getByRole("img", { name: new RegExp(`^${name}, `) });
    await expect(marks).toHaveCount(weekDays.length);
    await expect(page.getByRole("link", { name: /^Abrir el (?!chat$)/ })).toHaveCount(pastDays.length);
    await expect(page.getByRole("link", { name: openName(today) })).toHaveCount(0);

    if (day !== undefined) {
      const mark = page.getByRole("img", { name: `${name}, ${longName(day)}: no hecho` });
      await expect(mark).toHaveAttribute("data-state", "empty");

      await page.getByRole("link", { name: openName(day) }).click();
      await page.waitForURL(`**/dia/${day}`);
      await page.locator("button", { hasText: name }).click();
      await expect(page.locator("button", { hasText: name }).locator("svg")).toBeVisible();

      await page.goto("/semana");
      const after = page.getByRole("img", { name: `${name}, ${longName(day)}: hecho` });
      await expect(after).toHaveAttribute("data-state", "declared");
    }
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});

test("the week holds at 360px with its links, every day link and every commitment row at least 48px (RP-06, RNP-07)", async ({
  page,
  db,
  personId,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const name = `Compromiso semana ${Date.now()}`;
  const goalId = await seedGoal(db, personId, name);
  try {
    await page.goto("/semana");
    await expect(page.getByText("Meta semana pasada").locator("visible=true").first()).toBeVisible();

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);

    const links = await page
      .getByRole("link", { name: /^Abrir el (?!chat$)/ })
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(links.length).toBe(pastDays.length);
    for (const height of links) expect(height).toBeGreaterThanOrEqual(48);

    const row = page.locator("p", { hasText: name }).locator("xpath=..");
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});
