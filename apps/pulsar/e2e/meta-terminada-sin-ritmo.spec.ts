import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

import { test, expect } from "./fixtures";

// 846: a goal that has ended draws no running-month pace line (821, docs/pulsar/DESIGN.md).
// The pace line exists from the 20th of the month, so both tests skip before it; run them
// under `PULSAR_CLOCK=2026-10-31` exported to the server and the spec alike.

const today = todayInZone();
const day = Number(today.slice(8, 10));
const thisMonth = `${today.slice(0, 7)}-01`;
const PACE_FROM = "the pace line does not exist before the 20th";

function plusDays(from: string, days: number): string {
  const date = civilDateToDate(from);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

async function seed(db: import("postgres").Sql, personId: string, name: string, horizon: string) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${name}, ${horizon}::date, 'minutos', 'minutos', now() - interval '60 days')
    returning id
  `;
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${personId}, ${goal.id}, ${thisMonth}::date, 600)
  `;
  return goal.id;
}

test("846 · a goal ended under 60 % draws no «día N» pace line and reads «llevas 0 %»", async ({ page, db, personId }) => {
  test.skip(day < 20, PACE_FROM);
  const goalId = await seed(db, personId, `Sprint ${Date.now()}`, plusDays(today, -1));
  try {
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText(/^terminó el /)).toBeVisible();
    await expect(page.locator("main")).toHaveCount(1);
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(new RegExp(`día ${day}\\b`, "i"));
    expect(text).not.toMatch(/bajo el 60 %/i);
    // The ended month line takes the plain progress sentence in the pace line's place.
    expect(text).toMatch(/llevas 0 %/);
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("846 · an open goal under 60 % from the 20th still draws the pace line", async ({ page, db, personId }) => {
  test.skip(day < 20, PACE_FROM);
  const goalId = await seed(db, personId, `Abierta ${Date.now()}`, plusDays(today, 90));
  try {
    await page.goto(`/metas/${goalId}`);
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByText(new RegExp(`día ${day} ·.*bajo el 60 %`)).first()).toBeVisible();
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});
