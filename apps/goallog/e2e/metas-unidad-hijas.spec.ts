import type postgres from "postgres";

import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

import { test, expect } from "./fixtures";

// Module 900, clause 1 (board MetasUnidadArbol): a goal that holds goals and measures nothing reads
// its month line in its goals' unit, never a bare number.
const MONTH_LONG = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const today = todayInZone();
const month = `${today.slice(0, 7)}-01`;
const monthName = MONTH_LONG[Number(today.slice(5, 7)) - 1];

function inDays(days: number): string {
  const date = civilDateToDate(today);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

async function seedGoal(
  db: postgres.Sql,
  personId: string,
  name: string,
  unit: string | null,
  parentId: string | null,
): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, parent_id, created_at)
    values (${personId}, ${name}, ${inDays(300)}::date, ${unit}, ${unit}, ${parentId}, ${new Date(Date.now() - 20 * 86_400_000)})
    returning id`;
  return goal.id;
}

async function seedBudget(db: postgres.Sql, personId: string, goalId: string, amount: number) {
  await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${personId}, ${goalId}, ${month}::date, ${amount})`;
}

const norm = (text: string) => text.replace(/\s+/g, " ").trim();

test("/metas: a holder that measures nothing reads «0 min de 11 h», its goals' sum in their unit, never «0 de 660»", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: summing the holder's month but drawing it with the holder's own (null) unit, a bare «0 de 660».
  const stamp = Date.now();
  const holder = `Junior ${stamp}`;
  const first = `Base ${stamp}`;
  const second = `Caso ${stamp}`;
  const holderId = await seedGoal(db, person.id, holder, null, null);
  const a = await seedGoal(db, person.id, first, "min", holderId);
  const b = await seedGoal(db, person.id, second, "min", holderId);
  await seedBudget(db, person.id, a, 360);
  await seedBudget(db, person.id, b, 300);

  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 800 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/metas");
    const rowOf = (name: string) => page.locator("main").locator("a", { hasText: name });
    await expect(rowOf(holder)).toBeVisible();
    const holderText = norm(await rowOf(holder).innerText());
    expect(holderText).toContain(`${monthName} · 0 min de 11 h`);
    expect(holderText).not.toContain("0 de 660");
    expect(norm(await rowOf(first).innerText())).toContain(`${monthName} · 0 min de 6 h`);
    expect(norm(await rowOf(second).innerText())).toContain(`${monthName} · 0 min de 5 h`);
  } finally {
    await context.close();
  }
});
