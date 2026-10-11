import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// `UnidadUnaVez` (6_hoy): on Hoy every figure followed by «de» says its unit
// once, at the end; a figure with no «de» keeps its own. The month line's
// pace branch follows the clock the app reads, so both branches are written
// and the one true today is asserted.

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

test("Hoy says the unit once after «de» on the month line and on a partial row, and keeps it on a figure with no «de»", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const today = todayInZone();
  const monthStart = `${today.slice(0, 7)}-01`;
  const late = Number(today.slice(8, 10)) >= 20;
  const dayLabel = Number(today.slice(8, 10));

  const seedGoal = async (name: string, unit: string, budget: number | null) => {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${person.id}, ${name}, ${plusDays(90)}, ${unit}, ${unit}, now() - interval '40 days')
      returning id
    `;
    if (budget !== null) {
      await db`
        insert into goals.month_budgets (user_id, goal_id, month, amount)
        values (${person.id}, ${goal.id}, ${monthStart}::date, ${budget})
      `;
    }
    return goal.id;
  };
  const commitment = async (goalId: string, name: string, target: number, unit: string, quantity: number, day: string) => {
    const [row] = await db<{ id: string }[]>`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goalId}, ${name}, 'daily', 'quantity', ${target}, ${unit}, now() - interval '40 days')
      returning id
    `;
    await db`
      insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
      values (${person.id}, ${goalId}, ${row.id}, ${day}::date, ${quantity})
    `;
  };

  // 30 of 60, under 60 %: the pace line from the 20th.
  const vocab = await seedGoal(`Vocabulario ${stamp}`, "búsquedas", 60);
  await commitment(vocab, `Buscar ${stamp}`, 4, "búsquedas", 2, today);
  await commitment(vocab, `Buscar más ${stamp}`, 28, "búsquedas", 28, monthStart);
  // 36 of 40, over 60 %: the plain line at any date.
  const run = await seedGoal(`Correr ${stamp}`, "km", 40);
  await commitment(run, `Trotar ${stamp}`, 6, "km", 2, today);
  await commitment(run, `Trotar más ${stamp}`, 34, "km", 34, monthStart);
  // 2 h of 8 h, a time.
  const english = await seedGoal(`Inglés ${stamp}`, "minutos", 480);
  await commitment(english, `Estudiar ${stamp}`, 60, "minutos", 30, today);
  await commitment(english, `Estudiar más ${stamp}`, 90, "minutos", 90, monthStart);
  // A task but no amount this month: its line has no «de», so the unit stays.
  const bare = await seedGoal(`Portafolio ${stamp}`, "búsquedas", null);
  await commitment(bare, `Mostrar ${stamp}`, 9, "búsquedas", 5, monthStart);
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${person.id}, ${bare}, ${`Tarea ${stamp}`}, ${monthStart}::date)
  `;

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    const seen = (text: string) => page.getByText(text, { exact: true }).locator("visible=true");
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/");
    await expect(page.locator("main")).toHaveCount(1);
    await expect(seen(`Vocabulario ${stamp}`).first()).toBeVisible();

    // The month block: the figure before «de» carries no unit.
    if (late) {
      await expect(seen(`día ${dayLabel} · 30 de 60 búsquedas, bajo el 60 %`)).toHaveCount(1);
    } else {
      await expect(seen("30")).toHaveCount(1);
      await expect(seen("de 60 búsquedas")).toHaveCount(1);
    }
    await expect(seen("30 búsquedas")).toHaveCount(0);
    await expect(seen("36")).toHaveCount(1);
    await expect(seen("de 40 km")).toHaveCount(1);
    await expect(seen("36 km")).toHaveCount(0);
    if (late) {
      await expect(seen(`día ${dayLabel} · 2 h de 8 h, bajo el 60 %`)).toHaveCount(1);
    } else {
      await expect(seen("2 h")).toHaveCount(1);
      await expect(seen("de 8 h")).toHaveCount(1);
    }

    // A partial row: the logged amount carries no unit, the target does.
    const row = (text: RegExp) => page.getByText(text).locator("visible=true");
    await expect(row(/2 de 4 búsquedas/)).toHaveCount(1);
    await expect(row(/2 de 6 km/)).toHaveCount(1);
    await expect(row(/30 min de 1 h/)).toHaveCount(1);
    await expect(row(/2 búsquedas de 4/)).toHaveCount(0);

    // No «de»: the unit stays.
    await expect(seen("5 búsquedas")).toHaveCount(1);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});
