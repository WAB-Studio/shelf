import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { todayInZone } from "../lib/zone";
import { boxOf } from "./box";

// 687: the goal's month block names where its amount comes from when it is the
// month's own and a rhythm stands beside it: «en lugar del ritmo», under the figure.

const IN_LIEU = "en lugar del ritmo";
const today = todayInZone();
const monthStart = `${today.slice(0, 7)}-01`;
const horizon = `${Number(today.slice(0, 4)) + 1}-${today.slice(5, 7)}-01`;

async function seed(db: postgres.Sql, personId: string, input: { rhythm: number | null; budget: number | null }) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${personId}, ${`Meta en lugar ${Date.now()}`}, ${horizon}::date, 'minutos', 'minutos', ${input.rhythm}, now() - interval '40 days')
    returning id
  `;
  if (input.budget !== null) {
    await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${personId}, ${goal.id}, ${monthStart}::date, ${input.budget})`;
  }
  return goal.id;
}

async function drop(db: postgres.Sql, personId: string) {
  await db`delete from goals.goals where user_id = ${personId}`;
}

const line = (page: Page) => page.getByText(IN_LIEU, { exact: true }).locator("visible=true");

for (const width of [360, 1440]) {
  test.describe(`at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("a month amount beside a rhythm says «en lugar del ritmo» under its figure", async ({ page, db, personId }) => {
      const goalId = await seed(db, personId, { rhythm: 720, budget: 1200 });
      try {
        await page.goto(`/metas/${goalId}`);
        await expect(line(page)).toHaveCount(1);
        const figure = (await boxOf(page.getByText(/ de 20 h/).locator("visible=true").first()));
        const meta = (await boxOf(line(page)));
        expect(meta.y).toBeGreaterThan(figure.y);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      } finally {
        await drop(db, personId);
      }
    });

    test("a month amount that happens to equal the rhythm is still the month's own", async ({ page, db, personId }) => {
      const goalId = await seed(db, personId, { rhythm: 720, budget: 720 });
      try {
        await page.goto(`/metas/${goalId}`);
        await expect(line(page)).toHaveCount(1);
      } finally {
        await drop(db, personId);
      }
    });

    test("the amount the rhythm gives says nothing: no month row to stand in for it", async ({ page, db, personId }) => {
      const goalId = await seed(db, personId, { rhythm: 720, budget: null });
      try {
        await page.goto(`/metas/${goalId}`);
        await expect(page.getByText(/ de 12 h/).locator("visible=true").first()).toBeVisible();
        await expect(page.getByText(IN_LIEU)).toHaveCount(0);
      } finally {
        await drop(db, personId);
      }
    });

    test("a month amount with no rhythm beside it says nothing", async ({ page, db, personId }) => {
      const goalId = await seed(db, personId, { rhythm: null, budget: 1200 });
      try {
        await page.goto(`/metas/${goalId}`);
        await expect(page.getByText(/ de 20 h/).locator("visible=true").first()).toBeVisible();
        await expect(page.getByText(IN_LIEU)).toHaveCount(0);
      } finally {
        await drop(db, personId);
      }
    });
  });
}
