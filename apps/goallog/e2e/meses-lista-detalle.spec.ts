import { test, expect } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// `MesesListaDetalle.dc.html`, RNP-17: in the months list beside
// the open month, each chevron stays inside its row, the reached figures share
// one left edge, and the page has one `h1` with the month's heading an `h2`.
const thisMonth = monthOf(todayInZone());
const lastMonth = monthOf(dayBefore(thisMonth));
const monthBefore = monthOf(dayBefore(lastMonth));

for (const width of [1024, 1440]) {
  test(`at ${width}px the months list keeps its chevrons in their rows, its figures in one column and one h1`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${person.id}, ${`Meta meses ${width} ${Date.now()}`}, ${thisMonth}::date + 62, 'minutos', 'minutos', (${monthBefore}::date + 14) + time '12:00' at time zone 'UTC')
      returning id`;
    // Reached figures of different lengths: «5 min», «1 h 30 min», «100 h».
    for (const [month, reached, planned] of [
      [monthBefore, 5, 600],
      [lastMonth, 6000, 6000],
    ] as const) {
      const [task] = await db<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
        values (${person.id}, ${goal.id}, 'Hecha', ${month}::date, ${reached}) returning id`;
      await db`
        insert into goals.facts (user_id, goal_id, one_off_id, day)
        values (${person.id}, ${goal.id}, ${task.id}, ${month}::date + 14)`;
      await db`
        insert into goals.month_budgets (user_id, goal_id, month, amount)
        values (${person.id}, ${goal.id}, ${month}::date, ${planned})`;
    }
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/metas/${goal.id}/meses`);
      const rows = page.locator("main ol > li");
      await expect(rows.first()).toBeVisible();

      const measured = await rows.evaluateAll((items) =>
        items.map((li) => {
          const box = li.getBoundingClientRect();
          const chevron = li.querySelector("svg")?.getBoundingClientRect();
          const figure = li.querySelector<HTMLElement>('[data-part="table-stack-figure"]');
          return {
            chevronPast: chevron ? chevron.right - box.right : null,
            figureLeft: figure && figure.textContent?.trim() !== "—" ? figure.getBoundingClientRect().left - box.left : null,
          };
        }),
      );
      expect(measured.length).toBeGreaterThan(1);
      for (const row of measured) {
        expect(row.chevronPast).not.toBeNull();
        expect(row.chevronPast!).toBeLessThanOrEqual(0.5);
      }
      const edges = measured.map((row) => row.figureLeft).filter((left): left is number => left !== null);
      expect(edges.length).toBeGreaterThan(1);
      expect(Math.max(...edges) - Math.min(...edges)).toBeLessThan(1);

      expect(await page.locator("h1").count()).toBe(1);
      const detail = page.locator("main h2").first();
      await expect(detail).toBeVisible();
      expect(await page.locator("main h1").count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    } finally {
      await context.close();
    }
  });
}
