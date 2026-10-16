import { test, expect } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// RP-28: the amount sheet returns to the screen that opened it.

const thisMonth = monthOf(todayInZone());
const lastMonth = monthOf(dayBefore(thisMonth));
const horizon = nextMonth(nextMonth(thisMonth));
const seg = thisMonth.slice(0, 7);

test("saving the amount lands back on the month page, on Mes and on the goal that opened the sheet", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const name = `Meta vuelve ${stamp}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${name}, ${horizon}::date, 'minutos', 'minutos', (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
    returning id
  `;
  const goalId = goal.id;
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    const sheet = page.getByRole("dialog");
    const save = async (hours: string) => {
      await sheet.getByLabel("horas", { exact: true }).fill(hours);
      await sheet.getByLabel("minutos", { exact: true }).fill("0");
      await sheet.getByRole("button", { name: "Guardar" }).click();
      await expect(sheet).toHaveCount(0);
    };
    const reset = () => db`delete from goals.month_budgets where goal_id = ${goalId}`;

    // From the month's own page.
    await page.goto(`/metas/${goalId}/meses/${seg}`);
    await page.locator("main a[href*=planear]:visible").first().click();
    await save("3");
    await expect(page).toHaveURL(new RegExp(`/metas/${goalId}/meses/${seg}$`));
    await expect(page.locator("main")).toContainText("de 3 h");
    await reset();

    // From Mes.
    await page.goto("/mes");
    const block = page.locator("section", { has: page.getByRole("heading", { name }) });
    await block.getByRole("link", { name: /^Planear / }).click();
    await save("4");
    await expect(page).toHaveURL(/\/mes$/);
    await reset();

    // From the goal.
    await page.goto(`/metas/${goalId}`);
    await page.getByRole("link", { name: /^Planear / }).first().click();
    await save("5");
    await expect(page).toHaveURL(new RegExp(`/metas/${goalId}$`));
    await reset();

    // A crafted origin is not followed.
    await page.goto(`/metas/${goalId}/meses?planear=${seg}&volver=${encodeURIComponent("//evil.example")}`);
    await save("1");
    await expect(page).toHaveURL(new RegExp(`/metas/${goalId}/meses$`));
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});
