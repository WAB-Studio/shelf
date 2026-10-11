import type { Browser, Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, settled, type Person } from "./fixtures";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// 848, board `ParteExplicada` (RP-76): a month that is only a share of the
// goal's rhythm says so in one muted line under its figure, «desde el 7: 8 h 03
// min de tus 10 h», on the goal's month block and in «Este mes» of the month's
// page. A whole month says nothing. A last month that stops early reads
// «hasta el 7: …» (assumed by symmetry; the board drew only the first month).
// Day-independent: the goal opens today, the share is RP-76's formula.

const RHYTHM = 600;
const today = todayInZone();
const year = Number(today.slice(0, 4));
const monthIndex = Number(today.slice(5, 7));
const dayOfMonth = Number(today.slice(8, 10));
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const shareOf = (days: number, dim: number) => Math.floor((RHYTHM * days) / dim);
const say = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")} min`;
};

const firstShare = shareOf(daysIn(year, monthIndex) - dayOfMonth + 1, daysIn(year, monthIndex));
const firstLine = `desde el ${dayOfMonth}: ${say(firstShare)} de tus 10 h`;

// Bogotá's midnight of a civil day, the clock the app reads.
async function seed(
  db: postgres.Sql,
  person: Person,
  input: { name: string; openedOn: string | null; horizon: string },
) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${person.id}, ${input.name}, ${input.horizon}::date, 'minutos', 'minutos', ${RHYTHM},
      ${input.openedOn ? db`${input.openedOn}::date::timestamp at time zone 'America/Bogota'` : db`now() - interval '70 days'`})
    returning id
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, estimate, in_plan, position)
    values (${person.id}, ${goal.id}, ${`Tarea ${input.name}`}, 780, true, 0)
  `;
  return goal.id;
}

async function open(browser: Browser, baseURL: string, person: Person, width: number, path: string) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL, viewport: { width, height: 900 } });
  const page = await context.newPage();
  await page.goto(path);
  await settled(page);
  return { context, page };
}

const visible = (page: Page, text: string | RegExp, exact = false) =>
  page.getByText(text, { exact }).locator("visible=true");

const color = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).color);
const top = async (locator: Locator) => (await locator.boundingBox())!.y;

const horizonFar = `${year + 2}-${String(monthIndex).padStart(2, "0")}-01`;

for (const width of [360, 1280]) {
  test(`${width} · the goal's month block says the share under its figure, before the bar (RP-76)`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    test.skip(dayOfMonth === 1, "opened on the 1st the month is whole: no share to explain");
    const goalId = await seed(db, person, { name: `Parte meta ${width}`, openedOn: today, horizon: horizonFar });
    const { context, page } = await open(browser, baseURL!, person, width, `/metas/${goalId}`);
    try {
      const line = visible(page, firstLine, true);
      await expect(line).toHaveCount(1);

      // Figure, then the line, then the bar, then «llevas».
      const figure = page.getByText(new RegExp(`de ${say(firstShare)}$`)).locator("visible=true").first();
      const bar = page.locator("[class*='progress-module'][class*='__track']").locator("visible=true");
      const lleva = visible(page, /^(llevas \d+ %|día \d+ ·)/);
      await expect(bar).toHaveCount(1);
      const [y0, y1, y2, y3] = [await top(figure), await top(line), await top(bar), await top(lleva)];
      expect(y1).toBeGreaterThan(y0);
      expect(y2).toBeGreaterThan(y1);
      expect(y3).toBeGreaterThan(y2);

      // The share and the rhythm are figure spans, the day is plain text.
      const figures = await line.locator("[class*='figure-module'][class*='__figure']").allTextContents();
      expect(figures).toEqual([say(firstShare), "10 h"]);

      // Muted like «llevas…» (or, from the 20th when the pace line replaces it, like «en total…»).
      const reference = dayOfMonth >= 20 ? visible(page, /^en total, desde el/) : lleva;
      expect(await color(line)).toBe(await color(reference));
      const ink = page.getByRole("heading", { level: 1 }).locator("visible=true").first();
      expect(await color(line)).not.toBe(await color(ink));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });
}

test("360 · «Este mes» of the month's page says the share under its figure, before the tasks", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  test.skip(dayOfMonth === 1, "opened on the 1st the month is whole: no share to explain");
  const goalId = await seed(db, person, { name: "Parte mes", openedOn: today, horizon: horizonFar });
  const { context, page } = await open(browser, baseURL!, person, 360, `/metas/${goalId}/meses/${monthOf(today).slice(0, 7)}`);
  try {
    const line = visible(page, firstLine, true);
    await expect(line).toHaveCount(1);
    const section = visible(page, /^este mes$/i);
    const figure = page.getByText(new RegExp(`^de ${say(firstShare)}$`)).locator("visible=true").first();
    const tasks = visible(page, new RegExp(`^tareas · ${say(firstShare)}$`, "i"));
    await expect(tasks).toHaveCount(1);
    const [y0, y1, y2, y3] = [await top(section), await top(figure), await top(line), await top(tasks)];
    expect(y1).toBeGreaterThan(y0);
    expect(y2).toBeGreaterThan(y1);
    expect(y3).toBeGreaterThan(y2);
    const figures = await line.locator("[class*='figure-module'][class*='__figure']").allTextContents();
    expect(figures).toEqual([say(firstShare), "10 h"]);
    const ink = page.getByRole("heading", { level: 1 }).locator("visible=true").first();
    expect(await color(line)).not.toBe(await color(ink));
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("360 · a month the goal fills whole has no line, on the goal and on its month page", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const first = `${monthOf(today).slice(0, 7)}-01`;
  const goalId = await seed(db, person, { name: "Parte entera", openedOn: first, horizon: horizonFar });
  // A goal opened long before: the current month is a middle one.
  const middleId = await seed(db, person, { name: "Parte media", openedOn: null, horizon: horizonFar });
  try {
    for (const id of [goalId, middleId]) {
      const goal = await open(browser, baseURL!, person, 360, `/metas/${id}`);
      try {
        // Anchor on the month's own figure so an absent line is read on a drawn page.
        await expect(visible(goal.page, /llevas \d+ %|día \d+ ·/)).toHaveCount(1);
        await expect(goal.page.getByText(/^desde el \d+:|^hasta el \d+:/)).toHaveCount(0);
        await goal.page.goto(`/metas/${id}/meses/${monthOf(today).slice(0, 7)}`);
        await settled(goal.page);
        await expect(visible(goal.page, /^tareas · /i)).toHaveCount(1);
        await expect(goal.page.getByText(/^desde el \d+:|^hasta el \d+:/)).toHaveCount(0);
      } finally {
        await goal.context.close();
      }
    }
  } finally {
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("360 · a last month that stops before the month's end reads «hasta el N: …» with the goal's days in it", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Opened long ago and ending today, still open, so the month is the current one
  // and the month page reads it as «Este mes». On the month's last day it ends
  // before the next month's 8th instead. The horizon is the day after the goal.
  const dim = daysIn(year, monthIndex);
  const current = dayOfMonth < dim;
  const month = current ? monthOf(today) : nextMonth(monthOf(today));
  const lastDay = current ? dayOfMonth : 7;
  const monthDim = current ? dim : daysIn(Number(month.slice(0, 4)), Number(month.slice(5, 7)));
  const share = shareOf(lastDay, monthDim);
  const horizon = current ? `${monthOf(today).slice(0, 7)}-${String(dayOfMonth + 1).padStart(2, "0")}` : `${month.slice(0, 7)}-08`;
  const goalId = await seed(db, person, { name: "Parte última", openedOn: null, horizon });
  const { context, page } = await open(browser, baseURL!, person, 360, `/metas/${goalId}/meses/${month.slice(0, 7)}`);
  try {
    const line = visible(page, `hasta el ${lastDay}: ${say(share)} de tus 10 h`, true);
    await expect(line).toHaveCount(1);
    const tasks = visible(page, new RegExp(`^tareas · ${say(share)}$`, "i"));
    await expect(tasks).toHaveCount(1);
    expect(await top(line)).toBeLessThan(await top(tasks));
    const figures = await line.locator("[class*='figure-module'][class*='__figure']").allTextContents();
    expect(figures).toEqual([say(share), "10 h"]);
    const ink = page.getByRole("heading", { level: 1 }).locator("visible=true").first();
    expect(await color(line)).not.toBe(await color(ink));
    // The goal opened long before: its first month is whole in its own days, no line there.
    if (!current) {
      await page.goto(`/metas/${goalId}/meses/${monthOf(today).slice(0, 7)}`);
      await settled(page);
      await expect(visible(page, /^tareas · /i)).toHaveCount(1);
      await expect(page.getByText(/^desde el \d+:|^hasta el \d+:/)).toHaveCount(0);
    }
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("360 · a goal opened and ended inside one month reads «del N al M: …» on its month page", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Fixed days of a month next year, so the test reads the same on any day.
  const y = year + 1;
  const share = shareOf(14, daysIn(y, 3));
  const goalId = await seed(db, person, { name: "Parte dentro", openedOn: `${y}-03-07`, horizon: `${y}-03-21` });
  const { context, page } = await open(browser, baseURL!, person, 360, `/metas/${goalId}/meses/${y}-03`);
  try {
    const line = visible(page, `del 7 al 20: ${say(share)} de tus 10 h`, true);
    await expect(line).toHaveCount(1);
    const figures = await line.locator("[class*='figure-module'][class*='__figure']").allTextContents();
    expect(figures).toEqual([say(share), "10 h"]);
    const ink = page.getByRole("heading", { level: 1 }).locator("visible=true").first();
    expect(await color(line)).not.toBe(await color(ink));
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});
