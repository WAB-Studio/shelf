import type { Locator } from "@playwright/test";

import { todayInZone, weekOf } from "@/lib/zone";

import { test, expect } from "./fixtures";
import { boxOf } from "./box";
import { seedOpenGoal, visit } from "./metas-sin-final-seed";
import { shift } from "./sin-final-seed";

import type { Db } from "./meta-arbol-seed";
import type { Person } from "./fixtures";

// Module 994, board PorSemanaTelefono (approved 2026-10-14): at 360 every week of «Por semana» is a stacked row «semana N» / its dates /
// the phase UNDER the dates, on the week where the phase starts only; the current week reads «{dates} · en curso» on the dates' own line,
// with no note to the right. The wide face is `por-semana-ancha.spec.ts`'s and does not change.
// «Novela»: no end, 14 weeks, «Primer borrador» from week 5, «Revisión» from week 10.

test.use({ actionTimeout: 6000 });

const noonOf = (day: string) => new Date(`${day}T12:00:00-05:00`);
const weeksAgo = (n: number) => noonOf(shift(weekOf(todayInZone())[0], -7 * n));
const DATES = /^\d{1,2}(?: \w{3})?[–-]\d{1,2} \w{3} \d{4}$/;

async function seedNovela(db: Db, person: Person) {
  const start = weekOf(todayInZone())[0];
  const id = await seedOpenGoal(db, person, {
    name: "Novela",
    unit: { measure: "palabras", unit: "palabras" },
    horizon: null,
    created: weeksAgo(13),
  });
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${id}, 'Palabras', 'daily', 'quantity', 500, 'palabras', ${weeksAgo(13)})
    returning id`;
  for (let back = 13; back >= 0; back--) {
    await db`
      insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
      values (${person.id}, ${commitment.id}, ${id}, ${shift(start, -7 * back)}::date, ${1000 + back * 100})`;
  }
  await db`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${person.id}, ${id}, 'Primer borrador', ${shift(start, -7 * 9)}::date, ${shift(start, -7 * 5 + 6)}::date),
           (${person.id}, ${id}, 'Revisión', ${shift(start, -7 * 4)}::date, ${shift(start, 6)}::date)`;
  return id;
}

// The list shows the last 12 of 14 weeks, so week N is the (N - 2)th row. The label and the dates are two spans of one row, so its text has no space between them.
const rowOf = (list: Locator, n: number) => list.locator(":scope > li").nth(n - 3);

test("at 360 the phase is named under the dates of the week where it starts, and on no other week", async ({ person, browser, baseURL, db }) => {
  // Kills: the phase drawn on every row it spans; the phase left out of the phone's stack; the phase beside the dates instead of under them.
  const id = await seedNovela(db, person);
  const { page, context } = await visit(browser, baseURL, person, `/metas/${id}/revision`, 360);
  try {
    const list = page.locator("main ol:visible");
    await expect(list.locator(":scope > li")).toHaveCount(12);
    for (const [week, phase] of [[5, "Primer borrador"], [10, "Revisión"]] as const) {
      const row = rowOf(list, week);
      await expect(row).toContainText(new RegExp(`^semana ${week}`));
      const name = row.getByText(phase, { exact: true });
      await expect(name).toHaveCount(1);
      const dates = await boxOf(row.getByText(DATES));
      const under = await boxOf(name);
      expect(under.y, `«${phase}» sits below the dates' line`).toBeGreaterThanOrEqual(dates.y + dates.height - 1);
      expect(Math.abs(under.x - dates.x), `«${phase}» starts where the dates do`).toBeLessThanOrEqual(4);
    }
    for (const week of [3, 4, 6, 7, 8, 9, 11, 12, 13]) {
      const row = rowOf(list, week);
      await expect(row).toContainText(new RegExp(`^semana ${week}`));
      await expect(row).not.toContainText(/Primer borrador|Revisión/);
    }
    await expect(list.getByText("Primer borrador")).toHaveCount(1);
    await expect(list.getByText("Revisión")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("at 360 the current week reads «{dates} · en curso» on one line, with no note of its own to the right", async ({ person, browser, baseURL, db }) => {
  // Kills: «en curso» left in the row's `note` (a separate element at the right of the figure, as c67dc44e draws it).
  const id = await seedNovela(db, person);
  const { page, context } = await visit(browser, baseURL, person, `/metas/${id}/revision`, 360);
  try {
    const list = page.locator("main ol:visible");
    const current = list.locator("> li[data-current]");
    await expect(current).toHaveCount(1);
    await expect(current).toContainText(/^semana 14/);
    const line = current.getByText(/^\d{1,2}(?: \w{3})?[–-]\d{1,2} \w{3} \d{4} · en curso$/);
    await expect(line).toHaveCount(1);
    await expect(current.getByText("en curso", { exact: true })).toHaveCount(0);
    await expect(list.getByText(/en curso/)).toHaveCount(1);

    const plain = await boxOf(rowOf(list, 13).getByText(DATES));
    const mine = await boxOf(line);
    expect(mine.height, "dates and mark share one line").toBeLessThanOrEqual(plain.height * 1.5);
    expect(mine.x, "the line starts where every row's dates do").toBeCloseTo(plain.x, 0);
    // The current week has no phase start of its own: nothing is drawn under its line.
    await expect(current).not.toContainText(/Primer borrador|Revisión/);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});
