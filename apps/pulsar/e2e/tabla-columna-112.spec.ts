import { test, expect } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// `MesesConAño.dc.html`, option B (approved 2026-10-10): the narrow table's label column is 112px, room for
// «septiembre 2027» on one line, at 360 and in the 320px list beside an open month at 1024.

const thisMonth = monthOf(todayInZone());
const lastMonth = monthOf(dayBefore(thisMonth));

for (const width of [360, 1024]) {
  test(`at ${width}px every month label in the months list is 112px wide`, async ({ person, browser, baseURL, db }) => {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${person.id}, ${`Columna 112 ${width} ${Date.now()}`}, ${thisMonth}::date + 62, 'minutos', 'minutos',
              (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
      returning id
    `;
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/metas/${goal.id}/meses`);
      const rows = page.locator("main ol li a");
      await expect(rows.first()).toBeVisible();

      const widths = await rows.evaluateAll((links) =>
        links
          .filter((link) => (link as HTMLElement).offsetParent !== null)
          .map((link) => {
            const label = link.firstElementChild as HTMLElement;
            return { text: (label.textContent ?? "").trim(), width: label.getBoundingClientRect().width };
          }),
      );
      expect(widths.length, "visible month rows").toBeGreaterThan(1);
      for (const { text, width: labelWidth } of widths) {
        expect(labelWidth, `label «${text}»`).toBeCloseTo(112, 0);
      }
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${goal.id} and user_id = ${person.id}`;
    }
  });
}
