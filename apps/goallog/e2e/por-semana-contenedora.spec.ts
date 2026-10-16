import { todayInZone, weekOf } from "@/lib/zone";

import { test, expect } from "./fixtures";
import { seedOpenGoal, visit, MINUTES } from "./metas-sin-final-seed";

import type { Db } from "./meta-arbol-seed";
import type { Person } from "./fixtures";

// Module 994, board PorSemanaContenedora (RP-123, approved 2026-10-14): «Por semana» of a goal that holds goals
// draws its table whenever the goals inside sum a unit — it asks for no measure name of its own — and says
// «mide en horas y minutos». When no goal inside measures, it keeps «Esta meta todavía no tiene cifra.» and no table.
// Written from the contract; every date is relative to today.

test.use({ actionTimeout: 6000 });

const path = (id: string) => `/metas/${id}/revision`;
const NO_FIGURE = "Esta meta todavía no tiene cifra.";

// The week opens on Monday and the goals are born that day (or just now when that noon is still ahead).
const opened = () => new Date(Math.min(Date.now() - 60_000, new Date(`${weekOf(todayInZone())[0]}T12:00:00-05:00`).getTime()));

// «Carrera en IA» holds «IA aplicada», which measures minutes and did 2 × 120 today: 4 h in the current week.
async function seedMeasuringHolder(db: Db, person: Person) {
  const created = opened();
  const holder = await seedOpenGoal(db, person, { name: "Carrera en IA", created });
  const kid = await seedOpenGoal(db, person, { name: "IA aplicada", parent: holder, unit: MINUTES, created });
  for (const name of ["Estudio", "Práctica"]) {
    const [commitment] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${kid}, ${name}, 'daily', 'quantity', 60, 'minutos', ${created})
      returning id`;
    await db`
      insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
      values (${person.id}, ${commitment.id}, ${kid}, ${todayInZone()}::date, 120)`;
  }
  return holder;
}

// The control: the goals inside measure nothing.
async function seedSilentHolder(db: Db, person: Person) {
  const created = opened();
  const holder = await seedOpenGoal(db, person, { name: "Vida ordenada", created });
  const kid = await seedOpenGoal(db, person, { name: "Cuidado", parent: holder, created });
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${person.id}, ${kid}, 'Estirar', 'daily', 'tap', ${created})`;
  return holder;
}

for (const width of [360, 1280]) {
  test(`${width}: «Por semana» of a goal that holds a time goal says «mide en horas y minutos» and draws the current week's 4 h, never «todavía no tiene cifra»`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    // Kills: the door `!goal.measureName` (c67dc44e) left in review-screen, which refuses a holder whose own measure name is empty.
    const holder = await seedMeasuringHolder(db, person);
    const { page, context } = await visit(browser, baseURL, person, path(holder), width);
    try {
      await expect(page.getByText(NO_FIGURE)).toHaveCount(0);
      await expect(page.getByText("mide en horas y minutos", { exact: true })).toBeVisible();
      const current = page.locator(width === 1280 ? "main tbody tr[data-current]:visible" : "main ol > li[data-current]:visible");
      await expect(current).toHaveCount(1);
      await expect(current).toContainText(/^semana 1/);
      await expect(current).toContainText(/(?<![\d.])4\s?h\b/);
      await expect(current).not.toContainText(/min\b/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });

  test(`${width}: a goal that holds goals that measure nothing keeps «Esta meta todavía no tiene cifra.» and draws no table`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    // Kills: a table of zeros drawn for a holder with no summed unit (the door removed outright instead of replaced by «no unit summed»).
    const holder = await seedSilentHolder(db, person);
    const { page, context } = await visit(browser, baseURL, person, path(holder), width);
    try {
      await expect(page.getByText(NO_FIGURE, { exact: true })).toBeVisible();
      await expect(page.locator("main table")).toHaveCount(0);
      await expect(page.locator("main ol > li")).toHaveCount(0);
      await expect(page.getByText(/^mide /)).toHaveCount(0);
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });
}

test("a holder born this week lists exactly one week, the current one, and the 4 h sit in it alone", async ({ person, browser, baseURL, db }) => {
  // Kills: the goals' weeks summed into a week of their own instead of the holder's (a second, empty row; or the 4 h in no row).
  const holder = await seedMeasuringHolder(db, person);
  const { page, context } = await visit(browser, baseURL, person, path(holder), 360);
  try {
    await expect(page.getByText("mide en horas y minutos", { exact: true })).toBeVisible();
    await expect(page.locator("main ol > li")).toHaveCount(1);
    await expect(page.locator("main ol > li[data-current]")).toHaveCount(1);
    await expect(page.locator("main ol > li").first()).toContainText(/(?<![\d.])4\s?h\b/);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});
