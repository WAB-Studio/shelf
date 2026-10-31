import type { Locator, Page } from "@playwright/test";

import { todayInZone, weekOf } from "@/lib/zone";

import { test, expect } from "./fixtures";
import { seedOpenGoal, visit } from "./metas-sin-final-seed";
import { shift } from "./sin-final-seed";

import type { Db } from "./meta-arbol-seed";
import type { Person } from "./fixtures";

// Module 980, board PorSemanaAncha (approved 2026-10-14): at 1280 «Por semana» draws a column only when some row has data. SEMANA and
// TOTAL always; FASE only when the goal has phases; NOTA only when some week has a note (no week carries one today, so it never comes
// out today, but the rule is «if there is data»). «en curso» is a mark after the current week's dates, never a column. At 360 nothing
// changes. Written from the contract; every date is relative to today; each test names its mutation.

test.use({ actionTimeout: 6000 });

const WORDS = { measure: "palabras", unit: "palabras" };
const noonOf = (day: string) => new Date(`${day}T12:00:00-05:00`);
const weeksAgo = (n: number) => noonOf(shift(weekOf(todayInZone())[0], -7 * n));

// `boundingBox()` answers null while the element is not drawn yet; wait for it first.
const boxOf = async (loc: Locator) => {
  await expect(loc).toBeVisible();
  return (await loc.boundingBox())!;
};

// «Escribir»: no end, opened `weeks` weeks ago, words, one word commitment with a fact in every week.
async function seedWeeks(db: Db, person: Person, name: string, weeks: number, withPhases: boolean) {
  const start = weekOf(todayInZone())[0];
  const id = await seedOpenGoal(db, person, { name, unit: WORDS, horizon: null, created: weeksAgo(weeks - 1) });
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${id}, ${"Palabras"}, 'daily', 'quantity', 500, 'palabras', ${weeksAgo(weeks - 1)})
    returning id`;
  for (let back = weeks - 1; back >= 0; back--) {
    await db`
      insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
      values (${person.id}, ${commitment.id}, ${id}, ${shift(start, -7 * back)}::date, ${1000 + back * 100})`;
  }
  if (withPhases) {
    await db`
      insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
      values (${person.id}, ${id}, 'Primer borrador', ${shift(start, -7 * 9)}::date, ${shift(start, -7 * 5 + 6)}::date),
             (${person.id}, ${id}, 'Revisión', ${shift(start, -7 * 4)}::date, ${shift(start, 6)}::date)`;
  }
  return id;
}

const path = (id: string) => `/metas/${id}/revision`;
// «Por semana» is one list of weeks drawn as bars (decided 2026-10-31): no table, no header, no column.
const weeks = (page: Page) => page.locator("main ol:visible > li");
const currentRow = (page: Page) => page.locator("main ol:visible > li[data-current]");

test.describe("«Por semana» at 1280", () => {
  test("a goal with no phases draws one row per week, each with its bar and its total, and no phase and no table", async ({ person, browser, baseURL, db }) => {
    // Kills: a table left under the bars; a phase name drawn for a goal that has none; a week with no bar or no total.
    const id = await seedWeeks(db, person, "Escribir", 14, false);
    const { page, context } = await visit(browser, baseURL, person, path(id), 1280);
    try {
      await expect(page.locator("main table")).toHaveCount(0);
      // A goal with no end lists its last 12 weeks, the current one last.
      await expect(weeks(page)).toHaveCount(12);
      for (const index of [0, 6, 11]) {
        const row = weeks(page).nth(index);
        await expect(row).toContainText(new RegExp(`^semana ${index + 3}`));
        await expect(row.locator('[data-part="progress-track"], span[aria-hidden]').first()).toBeAttached();
        await expect(row).toContainText(/\d/);
      }
      await expect(page.getByText(/^fase$/i)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("a goal with phases names each phase on the week it starts, once, and the rule runs down its weeks", async ({ person, browser, baseURL, db }) => {
    // Kills: a phase repeated on every week it spans; a phase never named.
    const id = await seedWeeks(db, person, "Novela", 14, true);
    const { page, context } = await visit(browser, baseURL, person, path(id), 1280);
    try {
      const list = page.locator("main ol:visible");
      await expect(list.getByText("Primer borrador", { exact: true })).toHaveCount(1);
      await expect(list.getByText("Revisión", { exact: true })).toHaveCount(1);
    } finally {
      await context.close();
    }
  });

  test("«en curso» is a mark after the current week's dates, in the label, not a column of its own", async ({ person, browser, baseURL, db }) => {
    // Kills: «en curso» dropped with the table, or drawn at the total's side.
    const id = await seedWeeks(db, person, "Escribir", 14, false);
    const { page, context } = await visit(browser, baseURL, person, path(id), 1280);
    try {
      const row = currentRow(page);
      await expect(row).toHaveCount(1);
      const mark = row.getByText(/ · en curso$/);
      const markBox = await boxOf(mark);
      const first = await boxOf(row.getByText(/^semana \d+/).first());
      const total = await boxOf(row.locator("span").last());
      expect(markBox.x, "the mark starts inside the label, left of the total").toBeLessThan(total.x);
      expect(markBox.x).toBeGreaterThanOrEqual(first.x - 1);
      await expect(page.locator("main ol:visible").getByText(/en curso/)).toHaveCount(1);
    } finally {
      await context.close();
    }
  });

  test("the total of each week runs to the list's right edge", async ({ person, browser, baseURL, db }) => {
    // Kills: the totals left beside their bars with the empty space at the right.
    const id = await seedWeeks(db, person, "Escribir", 14, false);
    const { page, context } = await visit(browser, baseURL, person, path(id), 1280);
    try {
      const list = await boxOf(page.locator("main ol:visible").first());
      const total = await boxOf(weeks(page).first().locator("span").last());
      expect(total.x + total.width).toBeGreaterThanOrEqual(list.x + list.width - 2);
    } finally {
      await context.close();
    }
  });
});

test.describe("«Por semana» at 360", () => {
  test("«en curso» rides the dates' line under the last row's label (PorSemanaTelefono)", async ({ person, browser, baseURL, db }) => {
    // Kills: «en curso» left in a note of its own.
    const id = await seedWeeks(db, person, "Escribir", 14, true);
    const { page, context } = await visit(browser, baseURL, person, path(id), 360);
    try {
      await expect(page.locator("main table")).toHaveCount(0);
      const row = page.locator("main ol > li[data-current]:visible");
      await expect(row).toHaveCount(1);
      await expect(row.getByText("en curso", { exact: true })).toHaveCount(0);
      const label = await boxOf(row.getByText(/^semana \d+/).first());
      const mark = await boxOf(row.getByText(/ · en curso$/));
      expect(mark.x).toBeGreaterThanOrEqual(label.x - 1);
      expect(mark.x + mark.width).toBeLessThanOrEqual(label.x + label.width + 1);
      expect(mark.y).toBeGreaterThan(label.y + 4);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    } finally {
      await context.close();
    }
  });
});
