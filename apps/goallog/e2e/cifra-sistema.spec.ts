import { test, expect } from "./fixtures";
import { todayInZone } from "@/lib/zone";

// `SistemaPiezas.dc.html`: a figure's unit stays glued to its
// number, in mono, and both stay on one line. Measured on the goal's commitment row at the
// phone and at 1280.
const stamp = Date.now();

for (const [width, height] of [
  [360, 740],
  [1280, 800],
] as const) {
  test(`at ${width}px a figure's unit sits within 6px of its number and the figure is mono on one line`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const today = todayInZone();
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${person.id}, ${`Meta cifra ${width} ${stamp}`}, ${`${today.slice(0, 4)}-12-31`}, 'kilómetros', 'kilómetros', now() - interval '20 days')
      returning id`;
    const [commitment] = await db<{ id: string }[]>`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goal.id}, ${`Correr ${width} ${stamp}`}, 'daily', 'quantity', 7, 'kilómetros', now() - interval '20 days')
      returning id`;
    await db`
      insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
      values (${person.id}, ${goal.id}, ${commitment.id}, ${today}::date, 3)`;

    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width, height },
    });
    try {
      const page = await context.newPage();
      // The goal's page holds the commitment's row at every width; Hoy's figures at 1280 are the navy block's and a card's big one.
      await page.goto(`/metas/${goal.id}`);
      await expect(page.getByRole("main").getByText(`Correr ${width} ${stamp}`).first()).toBeVisible();

      const measured = await page.evaluate(() => {
        const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0;
        // The navy block's key figure and a card's big one are set in the title face by design (DESIGN «Naranja y marino»): neither is a row figure.
        const figures = [...document.querySelectorAll<HTMLElement>("[data-part='figure']")].filter((figure) => visible(figure) && !figure.closest("[data-part='hero']") && ![...figure.classList].some((name) => /_big$/.test(name)));
        return figures.flatMap((figure) => {
          const unit = figure.querySelector<HTMLElement>("[data-part='figure-unit']");
          if (!unit) return [];
          const range = document.createRange();
          range.selectNodeContents(figure.firstChild!);
          const numberEnd = range.getBoundingClientRect().right;
          const style = getComputedStyle(figure);
          return [
            {
              gap: unit.getBoundingClientRect().left - numberEnd,
              family: style.fontFamily,
              lines: figure.getBoundingClientRect().height / parseFloat(style.lineHeight),
            },
          ];
        });
      });
      expect(measured.length).toBeGreaterThan(0);
      for (const figure of measured) {
        expect(figure.gap).toBeGreaterThanOrEqual(0);
        expect(figure.gap).toBeLessThanOrEqual(6);
        expect(figure.family).toMatch(/mono/i);
        expect(figure.lines).toBeLessThan(1.5);
      }
    } finally {
      await context.close();
    }
  });
}
