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
const headers = (page: Page) => page.locator("main table thead th:visible");
const currentRow = (page: Page) => page.locator("main tbody tr[data-current]:visible");

// A column whose cells are all empty is the gap the contract forbids: every drawn header has a non-empty cell under it.
async function expectNoEmptyColumn(page: Page) {
  const count = await headers(page).count();
  const rows = page.locator("main tbody tr:visible");
  const total = await rows.count();
  for (let column = 0; column < count; column++) {
    let filled = 0;
    for (let row = 0; row < total; row++) {
      if (((await rows.nth(row).locator("td, th").nth(column).innerText()) ?? "").trim() !== "") filled++;
    }
    const name = await headers(page).nth(column).innerText();
    expect(filled, `column «${name}» has at least one cell with data`).toBeGreaterThan(0);
  }
}

test.describe("«Por semana» at 1280", () => {
  test("a goal with no phases and no notes draws SEMANA and TOTAL only", async ({ person, browser, baseURL, db }) => {
    // Kills: FASE or NOTA drawn whatever the data (columns fixed at four, as on 55fe164f).
    const id = await seedWeeks(db, person, "Escribir", 14, false);
    const { page, context } = await visit(browser, baseURL, person, path(id), 1280);
    try {
      await expect(headers(page)).toHaveCount(2);
      await expect(headers(page).nth(0)).toHaveText(/semana/i);
      await expect(headers(page).nth(1)).toHaveText(/total/i);
      await expect(page.locator("main thead").getByText(/^fase$/i)).toHaveCount(0);
      await expect(page.locator("main thead").getByText(/^nota$/i)).toHaveCount(0);
      await expectNoEmptyColumn(page);
    } finally {
      await context.close();
    }
  });

  test("a goal with phases draws FASE, names each phase on the week it starts, and still no NOTA", async ({ person, browser, baseURL, db }) => {
    // Kills: FASE left out when the goal has phases; a phase repeated on every week it spans; NOTA drawn though no week has a note.
    const id = await seedWeeks(db, person, "Novela", 14, true);
    const { page, context } = await visit(browser, baseURL, person, path(id), 1280);
    try {
      await expect(headers(page)).toHaveCount(3);
      await expect(headers(page).nth(2)).toHaveText(/fase/i);
      await expect(page.locator("main thead").getByText(/^nota$/i)).toHaveCount(0);
      const body = page.locator("main tbody");
      await expect(body.getByText("Primer borrador", { exact: true })).toHaveCount(1);
      await expect(body.getByText("Revisión", { exact: true })).toHaveCount(1);
      await expectNoEmptyColumn(page);
    } finally {
      await context.close();
    }
  });

  test("«en curso» is a mark after the current week's dates, in the first column, not a column of its own", async ({ person, browser, baseURL, db }) => {
    // Kills: «en curso» kept as the note column's cell (it then sits at TOTAL's right, in a column of its own).
    const id = await seedWeeks(db, person, "Escribir", 14, false);
    const { page, context } = await visit(browser, baseURL, person, path(id), 1280);
    try {
      const row = currentRow(page);
      await expect(row).toHaveCount(1);
      const mark = row.getByText("en curso");
      const markBox = await boxOf(mark);
      const total = await boxOf(headers(page).nth(1));
      const first = await boxOf(headers(page).nth(0));
      expect(markBox.x, "the mark starts inside SEMANA's column, left of TOTAL's").toBeLessThan(total.x);
      expect(markBox.x).toBeGreaterThanOrEqual(first.x);
      // On the dates' own line: the mark's vertical middle is the line of «dd-dd mmm yyyy», the row's last line of text.
      const dates = row.getByText(/\d{1,2}(?:\s\w{3})?\s?[-–]\s?\d{1,2}\s\w{3}\s\d{4}/);
      const datesBox = await boxOf(dates.first());
      expect(Math.abs(markBox.y + markBox.height / 2 - (datesBox.y + datesBox.height / 2))).toBeLessThan(datesBox.height);
      expect(markBox.x, "after the dates' start: the mark follows them on their line").toBeGreaterThan(datesBox.x);
      // The other rows carry no mark.
      await expect(page.locator("main tbody").getByText("en curso")).toHaveCount(1);
    } finally {
      await context.close();
    }
  });

  test("with SEMANA and TOTAL alone, TOTAL runs to the table's right edge and no column is empty", async ({ person, browser, baseURL, db }) => {
    // Kills: two drawn columns left at their fixed widths with the empty space at the right, as an invisible NOTA column would leave it.
    const id = await seedWeeks(db, person, "Escribir", 14, false);
    const { page, context } = await visit(browser, baseURL, person, path(id), 1280);
    try {
      const table = await boxOf(page.locator("main table:visible").first());
      const lastHeader = await boxOf(headers(page).last());
      expect(lastHeader.x + lastHeader.width).toBeGreaterThanOrEqual(table.x + table.width - 2);
      const cells = await page.locator("main tbody tr:visible").first().locator("td, th").count();
      expect(cells).toBe(2);
    } finally {
      await context.close();
    }
  });
});

test.describe("«Por semana» at 360", () => {
  test("the stack is unchanged: «en curso» to the right of the last row's label, no header drawn", async ({ person, browser, baseURL, db }) => {
    // Kills: the wide face's mark or columns leaking into the phone's stack.
    const id = await seedWeeks(db, person, "Escribir", 14, true);
    const { page, context } = await visit(browser, baseURL, person, path(id), 360);
    try {
      await expect(headers(page)).toHaveCount(0);
      const row = page.locator("main ol > li[data-current]:visible");
      await expect(row).toHaveCount(1);
      const label = await boxOf(row.getByText(/^semana \d+/).first());
      const mark = await boxOf(row.getByText("en curso"));
      expect(mark.x).toBeGreaterThanOrEqual(label.x + label.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    } finally {
      await context.close();
    }
  });
});
