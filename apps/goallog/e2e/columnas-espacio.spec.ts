import type { Page } from "@playwright/test";

import { test, expect, visit } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// Split's columns and Panel space their children by a gap, never a margin
// (`HoyVacioEscritorio.dc.html`, `SistemaEspacio.dc.html`): 12 and up between
// an empty state's lines, 16 and up between cards, aligned on one edge.

const widths = [1024, 1440] as const;

type Rect = { top: number; bottom: number; left: number; right: number };

// Visible direct children of the element's parent, in order.
async function siblingRects(page: Page, text: string): Promise<Rect[]> {
  return page.getByText(text, { exact: true }).evaluate((el) => {
    const parent = el.parentElement!;
    return Array.from(parent.children)
      .map((c) => c.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }));
  });
}

for (const width of widths) {
  test(`at ${width} an empty Hoy spaces its heading, paragraph and buttons`, async ({ person, browser }) => {
    const context = await browser.newContext({ storageState: person.sessionFile });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.getByText("Todavía no hay nada que anotar.", { exact: true })).toBeVisible();
      const rects = await siblingRects(page, "Todavía no hay nada que anotar.");
      expect(rects.length).toBeGreaterThanOrEqual(4);
      const [title, body, first, second] = rects;
      expect(body.top - title.bottom).toBeGreaterThanOrEqual(12);
      // The buttons stand in a row or a stack, but never touch.
      const apart =
        Math.max(second.top - first.bottom, second.left - first.right, first.left - second.right);
      expect(apart).toBeGreaterThanOrEqual(12);
      expect(first.top - body.bottom).toBeGreaterThanOrEqual(12);
    } finally {
      await context.close();
    }
  });

  test(`at ${width} a full Hoy and a goal keep their cards apart and on one left edge`, async ({
    person,
    browser,
    db,
  }) => {
    const horizon = civilDateToDate(todayInZone());
    horizon.setUTCDate(horizon.getUTCDate() + 90);
    let goal!: { id: string };
    for (const name of ["Meta de columnas", "Otra meta de columnas"]) {
      [goal] = await db<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon)
        values (${person.id}, ${name}, ${dateToCivilDate(horizon)}) returning id
      `;
      await db`
        insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
        values (${person.id}, ${goal.id}, 'Tocar', 'daily', 'tap')
      `;
    }
    await db`insert into goals.one_offs (user_id, name, day) values (${person.id}, 'Suelta uno', null)`;
    const context = await browser.newContext({ storageState: person.sessionFile });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      let pairs = 0;
      for (const path of ["/", `/metas/${goal.id}`]) {
        await page.goto(path);
        await expect(page.locator("main")).toHaveCount(1);
        await expect(page.locator("main")).toBeVisible();
        // Cards: the 1px-bordered, 14px-radius boxes, grouped by their column.
        const groups = await page.locator("main").evaluate((main) => {
          const cards = Array.from(main.querySelectorAll("section, div")).filter((el) => {
            const s = getComputedStyle(el);
            return s.borderTopWidth === "1px" && s.borderTopLeftRadius === "14px";
          });
          const byParent = new Map<Element, Element[]>();
          for (const c of cards) {
            byParent.set(c.parentElement!, [...(byParent.get(c.parentElement!) ?? []), c]);
          }
          return Array.from(byParent.values()).map((g) =>
            g.map((c) => {
              const r = c.getBoundingClientRect();
              return { top: r.top, bottom: r.bottom, left: r.left };
            }),
          );
        });
        expect(groups.length).toBeGreaterThan(0);
        for (const group of groups) {
          for (let i = 1; i < group.length; i++) {
            pairs += 1;
            expect(group[i].top - group[i - 1].bottom).toBeCloseTo(16, 0);
            expect(group[i].left).toBeCloseTo(group[i - 1].left, 0);
          }
        }
      }
      expect(pairs, "no two cards stand in one column").toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
}

for (const width of widths) {
  // The Split's row gap keeps the aside's two parts apart; each part spaces its
  // own children (the card spec above) and never reaches across it.
  test(`at ${width} a goal's two aside parts stand 16 apart`, async ({ person, browser, db }) => {
    const horizon = civilDateToDate(todayInZone());
    horizon.setUTCDate(horizon.getUTCDate() + 120);
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon)
      values (${person.id}, ${`Meta aside ${width}`}, ${dateToCivilDate(horizon)}) returning id
    `;
    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
      values (${person.id}, ${goal.id}, 'Tocar', 'daily', 'tap')
    `;
    const context = await browser.newContext({ storageState: person.sessionFile });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await visit(page, `/metas/${goal.id}`);
      const gap = await page.locator("main").evaluate((main) => {
        const part = (name: string) => main.querySelector(`[data-part="split-${name}"]`)!;
        return part("after").getBoundingClientRect().top - part("before").getBoundingClientRect().bottom;
      });
      expect(gap).toBeCloseTo(16, 0);
    } finally {
      await context.close();
    }
  });
}
