import { test, expect } from "./fixtures";
import { MONTH_LONG, monthsAhead, thisMonth, today } from "./meta-arbol-seed";
import { seedOpenGoal, visit } from "./metas-sin-final-seed";

import type { Db } from "./meta-arbol-seed";
import type { Person } from "./fixtures";

// Module 994, board CifraUnFormato (approved 2026-10-14): one number format everywhere. A figure of four digits or more groups its
// thousands with a point — «2.100 de 6.000 palabras», never «2100 de 6000» — on the goal's month block and on Mes.
// A year is not a figure. «Escribir» plans 6000 palabras this month and has done 2100.

test.use({ actionTimeout: 6000 });

const WORDS = { measure: "palabras", unit: "palabras" };

async function seedEscribir(db: Db, person: Person) {
  const goal = await seedOpenGoal(db, person, { name: "Escribir", unit: WORDS, horizon: monthsAhead(5) });
  await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${goal}, ${thisMonth}::date, 6000)`;
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${goal}, 'Palabras', 'daily', 'quantity', 500, 'palabras', now() - interval '20 days')
    returning id`;
  await db`insert into goals.facts (user_id, commitment_id, goal_id, day, quantity) values (${person.id}, ${commitment.id}, ${goal}, ${today}::date, 2100)`;
  return goal;
}

// The page's whole text, one line, years out: what is left of a four-digit run is a figure.
const bareFigures = (text: string) => text.replace(/\b20\d\d\b/g, "").match(/(?<![\d.,])\d{4,}(?![\d])/g) ?? [];

for (const [name, path] of [
  ["Mes", (id: string) => `/metas/${id}/meses/${thisMonth.slice(0, 7)}`],
  ["the goal's month block", (id: string) => `/metas/${id}`],
] as const) {
  test(`360: ${name} of «Escribir» reads «2.100 de 6.000 palabras» and no figure of four digits runs ungrouped`, async ({ person, browser, baseURL, db }) => {
    // Kills: `Intl.NumberFormat("es")` with its default grouping, which leaves 2100 and 6000 bare.
    const goal = await seedEscribir(db, person);
    const { page, context } = await visit(browser, baseURL, person, path(goal), 360);
    try {
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      const text = ((await page.locator("main").first().innerText()) ?? "").replace(/\s+/g, " ");
      expect(text).toMatch(/2\.100 de 6\.000 palabras/);
      expect(bareFigures(text)).toEqual([]);
      expect(text).toContain(MONTH_LONG[Number(thisMonth.slice(5, 7)) - 1]);
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });
}
