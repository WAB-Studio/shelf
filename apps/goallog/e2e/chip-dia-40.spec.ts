import type postgres from "postgres";

import { test, expect, settled } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// `Chip day` is 40 px (decided 2026-10-13): the seven weekdays of «Compromiso nuevo» fit one row at 360
// (7 × 40 + 6 × 4 = 304), each at least 32 px, never the 44 px that dropped the D to a second row.
const DAYS = ["L", "M", "X", "J", "V", "S", "D"];

async function goalOf(db: postgres.Sql, personId: string): Promise<string> {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + 90);
  const [row] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${`Casillas ${Date.now()}`}, ${dateToCivilDate(date)}::date, now() - interval '3 days')
    returning id
  `;
  return row.id;
}

for (const width of [360]) {
  test(`at ${width} the seven day chips of «Compromiso nuevo» sit on one row, each at least 32 px, none past the page`, async ({
    person, browser, baseURL, db,
  }) => {
    const goal = await goalOf(db, person.id);
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width, height: 740 },
      hasTouch: true,
    });
    const page = await context.newPage();
    try {
      await page.goto(`/metas/${goal}/compromisos/nuevo`);
      await settled(page);
      await page.getByRole("radio", { name: "días sueltos", exact: true }).click();
      const chips = page.getByRole("main").getByRole("button", { name: /^(lunes|martes|miércoles|jueves|viernes|sábado|domingo)$/ });
      await expect(chips).toHaveCount(7);
      const boxes = await chips.evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { name: el.textContent!.trim(), top: r.top, left: r.left, right: r.right, width: r.width, height: r.height };
        }),
      );
      expect(boxes.map((b) => b.name)).toEqual(DAYS);
      expect(new Set(boxes.map((b) => Math.round(b.top))).size, `one row: ${JSON.stringify(boxes.map((b) => b.top))}`).toBe(1);
      for (const b of boxes) {
        expect(b.width, `${b.name} wide`).toBeGreaterThanOrEqual(32);
        expect(b.height, `${b.name} tall`).toBeGreaterThanOrEqual(32);
        expect(b.right, `${b.name} inside the page`).toBeLessThanOrEqual(width);
      }
      expect(Math.round(boxes[0].width), "the chip is 40, no longer 44").toBeLessThanOrEqual(42);
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${goal} and user_id = ${person.id}`;
    }
  });
}
