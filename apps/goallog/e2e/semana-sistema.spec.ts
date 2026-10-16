import type { Browser, Page } from "@playwright/test";

import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// Semana's sentences are Archivo and only its figures and dates are
// mono; the ended line sits one gap from its «ver» link, which is a `TextLink`;
// the eyebrow is the header's own string eyebrow.

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

const today = todayInZone();
const todayIndex = (civilDateToDate(today).getUTCDay() + 6) % 7;
const thisMonday = shift(today, -todayIndex);
const lastMonday = shift(thisMonday, -7);

async function withPage(browser: Browser, baseURL: string | undefined, storage: string, width: number, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ storageState: storage, baseURL: baseURL!, viewport: { width, height: 900 } });
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

const font = (locator: ReturnType<Page["locator"]>) =>
  locator.evaluate((el) => getComputedStyle(el).fontFamily);

test("the phone footer's words are Archivo and its figures mono; the legend words are Archivo", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  const created = new Date(`${shift(today, -40)}T17:00:00Z`);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, 'Inglés sistema', ${shift(today, 60)}, ${created}) returning id
  `;
  try {
    const [commitment] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goal.id}, 'Monólogo', 'daily', 'quantity', 30, 'minutos', ${created}) returning id
    `;
    for (const [day, quantity] of [[lastMonday, 29], [shift(lastMonday, 1), 30]] as const) {
      await db`
        insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
        values (${person.id}, ${goal.id}, ${commitment.id}, ${day}::date, ${quantity})
      `;
    }
    await withPage(browser, baseURL, person.sessionFile, 360, async (page) => {
      await page.goto(`/semana?semana=${lastMonday}`);
      // One footer sentence in Archivo; only its three figures are mono (371).
      const sum = page.locator("p").filter({ hasText: /^hechos \d+ de \d+ · \d+ en parte$/ }).filter({ visible: true });
      await expect(sum).toBeVisible();
      expect(await font(sum)).not.toMatch(/mono/i);
      await expect(sum.locator("span")).toHaveCount(3);
      for (const figure of await sum.locator("span").all()) expect(await font(figure)).toMatch(/mono/i);
      const legendWord = page.getByTestId("week-legend").getByText("pendiente", { exact: true });
      expect(await font(legendWord)).not.toMatch(/mono/i);
    });
  } finally {
    await db`delete from goals.goals where id = ${goal.id}`;
  }
});

for (const width of [360, 1280]) {
  test(`at ${width} the ended line is a sentence in Archivo beside a TextLink`, async ({
    browser,
    baseURL,
    db,
    person,
  }) => {
    test.skip(todayIndex === 0, "a goal ended yesterday belongs to last week on a Monday");
    const old = new Date(Date.now() - 60 * 86_400_000);
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, 'Meta terminada sistema', ${today}, ${old}) returning id
    `;
    try {
      await db`
        insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
        values (${person.id}, ${goal.id}, 'Compromiso', 'daily', 'tap', ${old})
      `;
      await withPage(browser, baseURL, person.sessionFile, width, async (page) => {
        await page.goto("/semana");
        const link = page.getByRole("link", { name: "Abrir Meta terminada sistema" }).filter({ visible: true });
        await expect(link).toHaveText("ver");
        const sentence = page.getByText(/^terminó el /).filter({ visible: true });
        expect(await font(sentence)).not.toMatch(/mono/i);
        const gap = await sentence.evaluate((el, a) => {
          const s = el.getBoundingClientRect();
          const l = a.getBoundingClientRect();
          return Math.round(l.left - s.right);
        }, await link.elementHandle());
        // Gap 2 (8px), not the old 44px button's air.
        expect(gap).toBeLessThanOrEqual(12);
      });
    } finally {
      await db`delete from goals.commitments where goal_id = ${goal.id}`;
      await db`delete from goals.goals where id = ${goal.id}`;
    }
  });
}

test("the eyebrow is the header's string eyebrow, in mono capitals", async ({ browser, baseURL, person }) => {
  await withPage(browser, baseURL, person.sessionFile, 360, async (page) => {
    await page.goto("/semana");
    const eyebrow = page.getByText("esta semana", { exact: true }).first();
    await expect(eyebrow).toBeVisible();
    expect(await eyebrow.evaluate((el) => getComputedStyle(el).textTransform)).toBe("uppercase");
  });
});
