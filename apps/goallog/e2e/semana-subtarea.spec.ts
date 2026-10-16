import type { Browser, Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// `HoyTareaMesSubtarea.dc.html`: a sub-task's
// row on Semana says «de <parent>» as its second line, Archivo muted; a
// top-level task draws no second line (RP-30, RP-44).

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

const today = todayInZone();
const thisMonday = shift(today, -((civilDateToDate(today).getUTCDay() + 6) % 7));
const lastMonday = shift(thisMonday, -7);

async function seedGoal(db: postgres.Sql, person: Person) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`Meta ${Date.now()}`}, ${shift(today, 90)}, ${new Date(`${shift(today, -40)}T17:00:00Z`)})
    returning id
  `;
  return goal.id;
}

async function seedTask(
  db: postgres.Sql,
  person: Person,
  goalId: string,
  name: string,
  parentId: string | null,
  doneOn: string | null,
) {
  const [row] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, parent_id)
    values (${person.id}, ${goalId}, ${name}, ${parentId}) returning id
  `;
  if (doneOn) {
    await db`
      insert into goals.facts (user_id, goal_id, one_off_id, day)
      values (${person.id}, ${goalId}, ${row.id}, ${doneOn}::date)
    `;
  }
  return row.id;
}

async function withPage(
  browser: Browser,
  baseURL: string | undefined,
  person: Person,
  width: number,
  run: (page: Page) => Promise<void>,
) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 900 });
    await run(page);
  } finally {
    await context.close();
  }
}

// The name of a row, visible on the face the width draws: the table's row header
// at desktop, the fold's name at the phone.
const nameOf = (page: Page, name: string) => page.getByText(name, { exact: true }).filter({ visible: true });
// The line right under the name, whichever face draws it.
const lineUnder = (name: Locator) => name.locator("xpath=following-sibling::*[1]");
const rowOf = (page: Page, name: string, width: number) =>
  width >= 1024
    ? page.getByRole("table").locator("tr", { has: page.getByRole("rowheader", { name: new RegExp(`^${name}`) }) })
    : nameOf(page, name).locator("xpath=..");

for (const width of [1440, 390]) {
  test(`at ${width}, a sub-task done this week reads «de <parent>» under its name (RP-30)`, async ({
    browser,
    baseURL,
    db,
    person,
  }) => {
    const stamp = Date.now();
    const parent = `Madre ${stamp}`;
    const child = `Hija ${stamp}`;
    const goalId = await seedGoal(db, person);
    try {
      const parentId = await seedTask(db, person, goalId, parent, null, null);
      await seedTask(db, person, goalId, child, parentId, today);
      await withPage(browser, baseURL, person, width, async (page) => {
        await page.goto("/semana");
        await expect(nameOf(page, child)).toBeVisible();
        await expect(lineUnder(nameOf(page, child))).toHaveText(`de ${parent}`);
        // The parent is a task with children, never a row of its own here.
        await expect(nameOf(page, parent)).toHaveCount(0);
      });
    } finally {
      await db`delete from goals.goals where id = ${goalId}`;
    }
  });

  test(`at ${width}, a top-level task done this week draws no second line (RP-30)`, async ({
    browser,
    baseURL,
    db,
    person,
  }) => {
    const stamp = Date.now();
    const solo = `Sola ${stamp}`;
    const goalId = await seedGoal(db, person);
    try {
      await seedTask(db, person, goalId, solo, null, today);
      await withPage(browser, baseURL, person, width, async (page) => {
        await page.goto("/semana");
        await expect(nameOf(page, solo)).toBeVisible();
        // The row's text is its name and nothing else: no «de », no empty name.
        await expect(rowOf(page, solo, width)).toHaveText(solo);
        await expect(page.getByText(/^de\s*$/).filter({ visible: true })).toHaveCount(0);
      });
    } finally {
      await db`delete from goals.goals where id = ${goalId}`;
    }
  });
}

test("a sub-task done last week, read from «‹», names its parent (RP-44)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  const stamp = Date.now();
  const parent = `Madre ${stamp}`;
  const child = `Hija ${stamp}`;
  const goalId = await seedGoal(db, person);
  try {
    const parentId = await seedTask(db, person, goalId, parent, null, null);
    await seedTask(db, person, goalId, child, parentId, shift(lastMonday, 1));
    for (const width of [1440, 390]) {
      await withPage(browser, baseURL, person, width, async (page) => {
        await page.goto("/semana");
        await page.getByRole("link", { name: "Semana anterior" }).click();
        await expect(page).toHaveURL(new RegExp(`/semana\\?semana=${lastMonday}$`));
        await expect(nameOf(page, child)).toBeVisible();
        await expect(lineUnder(nameOf(page, child))).toHaveText(`de ${parent}`);
      });
    }
  } finally {
    await db`delete from goals.goals where id = ${goalId}`;
  }
});

for (const width of [1440, 390]) {
  test(`at ${width}, «de <parent>» is a muted Archivo sentence, not DM Mono`, async ({
    browser,
    baseURL,
    db,
    person,
  }) => {
    const stamp = Date.now();
    const parent = `Madre ${stamp}`;
    const child = `Hija ${stamp}`;
    const goalId = await seedGoal(db, person);
    try {
      const parentId = await seedTask(db, person, goalId, parent, null, null);
      await seedTask(db, person, goalId, child, parentId, today);
      await withPage(browser, baseURL, person, width, async (page) => {
        await page.goto("/semana");
        const line = lineUnder(nameOf(page, child));
        await expect(line).toHaveText(`de ${parent}`);
        const paint = await line.evaluate((el) => {
          const probe = document.createElement("span");
          probe.style.color = "var(--pulsar-muted)";
          document.body.append(probe);
          const muted = getComputedStyle(probe).color;
          probe.remove();
          const cs = getComputedStyle(el);
          return { family: cs.fontFamily, color: cs.color, muted, body: getComputedStyle(document.body).fontFamily };
        });
        expect(paint.family).not.toMatch(/mono/i);
        expect(paint.family).toBe(paint.body);
        expect(paint.color).toBe(paint.muted);
      });
    } finally {
      await db`delete from goals.goals where id = ${goalId}`;
    }
  });
}

test("at 360, a 40-letter parent name wraps inside the screen (RNP-07)", async ({ browser, baseURL, db, person }) => {
  const stamp = Date.now();
  const parent = ["MMMMMMMMMM", "MMMMMMMMMM", "MMMMMMMMMM", "MMMMMMMMMM"].join(" ");
  const child = `Hija ${stamp}`;
  const goalId = await seedGoal(db, person);
  try {
    const parentId = await seedTask(db, person, goalId, parent, null, null);
    await seedTask(db, person, goalId, child, parentId, today);
    await withPage(browser, baseURL, person, 360, async (page) => {
      await page.goto("/semana");
      const line = lineUnder(nameOf(page, child));
      await expect(line).toHaveText(`de ${parent}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
      const box = await line.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    });
  } finally {
    await db`delete from goals.goals where id = ${goalId}`;
  }
});
