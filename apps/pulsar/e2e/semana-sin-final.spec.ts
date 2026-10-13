import type { Page } from "@playwright/test";

import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone, weekOf } from "../lib/zone";

// A goal that never ends has a null horizon: every day from its opening is live.
// Kills: reading a null horizon as «no day is live», which draws «no pedía» on every mark of the week.

const WIDTHS = [360, 1280];

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

function marks(page: Page, name: string, status: string) {
  return page.getByRole("img", { name: new RegExp(`^${name}, .*: ${status}$`) });
}

for (const width of WIDTHS) {
  test(`a goal with no end draws its logged day, today asked and none as «no pedía» in this week (${width})`, async ({ person, browser, baseURL, db }) => {
    const today = todayInZone();
    const done = `Sin final hecho ${Date.now()}`;
    const open = `Sin final abierto ${Date.now()}`;
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, ${`Meta sin final ${Date.now()}`}, null, now() - interval '20 days') returning id`;
    try {
      for (const name of [done, open]) {
        const [row] = await db<{ id: string }[]>`
          insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
          values (${person.id}, ${goal.id}, ${name}, 'daily', 'tap', now() - interval '20 days') returning id`;
        if (name === done) {
          for (const day of [today, shift(today, -1)].filter((d) => weekOf(today).includes(d))) {
            await db`insert into goals.facts (user_id, goal_id, commitment_id, day) values (${person.id}, ${goal.id}, ${row.id}, ${day}::date)`;
          }
        }
      }
      const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto("/semana");
        await expect(page.locator("main")).toHaveCount(1);
        await expect(marks(page, done, "no pedía")).toHaveCount(0);
        await expect(marks(page, open, "no pedía")).toHaveCount(0);
        await expect(marks(page, done, "hecho").first()).toBeVisible();
        const index = weekOf(today).indexOf(today);
        await expect(marks(page, done, "hecho")).toHaveCount(today === weekOf(today)[0] ? 1 : 2);
        await expect(marks(page, open, "no hecho")).toHaveCount(index + 1);
        await expect(marks(page, open, "no hecho").or(marks(page, open, "todavía no"))).toHaveCount(7);
      } finally {
        await context.close();
      }
    } finally {
      await db`delete from goals.goals where id = ${goal.id}`;
    }
  });

  test(`the days before a goal with no end opened stay «no pedía», the days from it on are asked (${width})`, async ({ person, browser, baseURL, db }) => {
    const lastMonday = shift(weekOf(todayInZone())[0], -7);
    const wednesday = shift(lastMonday, 2);
    const opened = new Date(`${wednesday}T08:00:00-05:00`);
    const name = `Sin final abierto el miércoles ${Date.now()}`;
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, ${`Meta sin final atrás ${Date.now()}`}, null, ${opened}) returning id`;
    try {
      const [row] = await db<{ id: string }[]>`
        insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
        values (${person.id}, ${goal.id}, ${name}, 'daily', 'tap', ${opened}) returning id`;
      await db`insert into goals.facts (user_id, goal_id, commitment_id, day) values (${person.id}, ${goal.id}, ${row.id}, ${shift(wednesday, 1)}::date)`;
      const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto(`/semana?semana=${lastMonday}`);
        await expect(page.locator("main")).toHaveCount(1);
        await expect(marks(page, name, "no pedía")).toHaveCount(2);
        await expect(marks(page, name, "hecho")).toHaveCount(1);
        await expect(marks(page, name, "no hecho")).toHaveCount(4);
      } finally {
        await context.close();
      }
    } finally {
      await db`delete from goals.goals where id = ${goal.id}`;
    }
  });
}
