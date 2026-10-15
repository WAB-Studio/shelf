import { test, expect } from "./fixtures";
import { todayInZone } from "@/lib/zone";

// RP-35, RP-49, RNP-07: a figure keeps its line («27 h 55 min» never breaks) and
// the wide table's label never touches the figure beside it. Measured on the
// report page, which draws both.
const stamp = Date.now();

test.describe("figures keep their line (RP-35, RP-49)", () => {
  test("at 1440 every figure is one line high and each label ends 12px before its figure; at 360 nothing scrolls sideways", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const today = todayInZone();
    const monthStart = `${today.slice(0, 7)}-01`;
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${person.id}, ${`Meta de cifras ${stamp}`}, ${`${today.slice(0, 4)}-12-31`}, 'minutos', 'minutos', now() - interval '70 days')
      returning id`;
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${goal.id}, ${monthStart}::date, 1675)`;
    const [commitment] = await db<{ id: string }[]>`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goal.id}, ${`Sesión ${stamp}`}, 'daily', 'quantity', 30, 'minutos', now() - interval '70 days')
      returning id`;
    await db`
      insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
      values (${person.id}, ${goal.id}, ${commitment.id}, ${today}::date, 1675)`;

    const wide = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width: 1440, height: 900 },
    });
    const phone = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width: 360, height: 740 },
    });
    try {
      const page = await wide.newPage();
      await page.goto("/exportar");
      await expect(page.getByRole("main").getByText(`Meta de cifras ${stamp}`).first()).toBeVisible();

      const measured = await page.evaluate(() => {
        const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0;
        const figures = [...document.querySelectorAll<HTMLElement>("[data-part='figure']")].filter(visible);
        // The report is wide enough to hide a break, so squeeze each figure to a
        // sliver as a block, the way a host that is not a flex box would hold it.
        for (const el of figures) {
          el.style.display = "block";
          el.style.width = "24px";
        }
        const tall = figures
          .filter((el) => el.getBoundingClientRect().height >= 1.5 * parseFloat(getComputedStyle(el).lineHeight))
          .map((el) => el.textContent);
        const gaps: number[] = [];
        for (const row of document.querySelectorAll("tbody tr, tr")) {
          const cells = [...row.querySelectorAll<HTMLElement>("td")].filter(visible);
          if (cells.length < 2) continue;
          const range = document.createRange();
          range.selectNodeContents(cells[0]);
          const labelEnd = range.getBoundingClientRect().right;
          range.selectNodeContents(cells[1]);
          const figureStart = range.getBoundingClientRect().left;
          gaps.push(figureStart - labelEnd);
        }
        return { count: figures.length, tall, gaps };
      });
      expect(measured.count).toBeGreaterThan(0);
      expect(measured.tall).toEqual([]);
      expect(measured.gaps.length).toBeGreaterThan(0);
      for (const gap of measured.gaps) expect(gap).toBeGreaterThanOrEqual(12);

      const small = await phone.newPage();
      await small.goto("/exportar");
      await expect(small.getByRole("main").getByText(`Meta de cifras ${stamp}`).first()).toBeVisible();
      const overflow = await small.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    } finally {
      await wide.close();
      await phone.close();
      await db`delete from goals.goals where id = ${goal.id} and user_id = ${person.id}`;
    }
  });
});
