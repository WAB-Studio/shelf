import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// Module 833 (`UnidadUnaVez`): on `/exportar`, on screen and on paper, a figure followed by «de» says its unit once, at
// the end («30 de 60 búsquedas»); a figure with no «de» keeps its unit («18 búsquedas»).

const today = todayInZone();
const thisMonth = monthOf(today);
const horizon = nextMonth(nextMonth(thisMonth));
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

async function seedGoal(db: postgres.Sql, person: Person, name: string, budget: number | null, done: number): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${`${name} ${Date.now()}`}, ${horizon}::date, 'búsquedas', 'searches', now() - interval '10 days')
    returning id`;
  if (budget !== null) {
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${goal.id}, ${thisMonth}::date, ${budget})`;
  }
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${goal.id}, 'Ronda', 'daily', 'quantity', 5, 'searches', now() - interval '10 days')
    returning id`;
  await db`
    insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
    values (${person.id}, ${commitment.id}, ${goal.id}, ${today}::date, ${done})`;
  return goal.id;
}

for (const media of ["screen", "print"] as const) {
  test(`exportar at 360 (${media}): this month, to date and the week say «búsquedas» once, after «de»`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const planned = await seedGoal(db, person, "Con plan", 60, 30);
    const loose = await seedGoal(db, person, "Sin plan", null, 18);
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    const page = await context.newPage();
    try {
      await page.setViewportSize({ width: 360, height: 900 });
      await page.goto("/exportar");
      await page.emulateMedia({ media });
      await expect(page.getByRole("main").first()).toContainText("HASTA HOY", { ignoreCase: true });
      const text = flat(await page.getByRole("main").first().innerText());
      expect(text).toMatch(/ESTE MES · \S+ 30 de 60 búsquedas/i);
      expect(text).toMatch(/HASTA HOY 30 de 60 búsquedas/i);
      // The week line is screen-only: the paper never prints it.
      if (media === "screen") {
        expect(text).toMatch(/Esta semana: 30 de \d+ búsquedas ?\./);
        expect(text).toMatch(/Esta semana: 18 búsquedas ?\./);
      }
    } finally {
      await context.close();
      await db`delete from goals.goals where id in ${db([planned, loose])} and user_id = ${person.id}`;
    }
  });
}

test("exportar at 360: the phone row of a month with a plan says «30 de 60 búsquedas», the unit once", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const goalId = await seedGoal(db, person, "Con plan", 60, 30);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto("/exportar");
    const current = page.locator("ol > li:visible").filter({ hasText: /en curso/ }).first();
    await expect(current).toBeVisible();
    expect(flat(await current.innerText())).toMatch(/en curso 30 de 60 búsquedas$/);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});
