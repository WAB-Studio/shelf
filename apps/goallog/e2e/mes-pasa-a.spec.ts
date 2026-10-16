import month from "../messages/es/month.json";
import { test, expect } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// RP-32, RP-35: a closed month says where its share went, with the next
// month's name (`PalabrasDelPlan`): «66 % pasó a octubre».

const NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const label = (m: string) => NAMES[Number(m.slice(5, 7)) - 1];
const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => values[key]);

const thisMonth = monthOf(todayInZone());
const lastMonth = monthOf(dayBefore(thisMonth));

test("a closed month reads «66 % pasó a <next month>» in the list and on its page (RP-32, RP-35)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${`Meta pasa ${Date.now()}`}, ${nextMonth(thisMonth)}::date, 'minutos', 'minutos', (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
    returning id
  `;
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${goal.id}, ${lastMonth}::date, 600)
  `;
  const [done] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${goal.id}, 'Hecha', ${lastMonth}::date, 100) returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${person.id}, ${goal.id}, ${done.id}, ${lastMonth}::date + 14)
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${goal.id}, 'Pendiente', ${lastMonth}::date, 200)
  `;

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 390, height: 900 } });
  try {
    const page = await context.newPage();
    const pasado = fill(month.months.carriedTo, { percent: "66", month: label(thisMonth) });

    await page.goto(`/metas/${goal.id}/meses`);
    await expect(page.getByRole("listitem").first()).toContainText(pasado);
    await expect(page.getByText(/se arrastró/)).toHaveCount(0);

    const closedLine = fill(month.list.closedLineTo.replace(/<\/?fig>/g, ""), {
      share: "66",
      next: label(thisMonth),
      owed: "3 h 20 min",
      planned: "5 h",
    });
    await page.goto(`/metas/${goal.id}/meses/${lastMonth.slice(0, 7)}`);
    await expect(page.getByText(closedLine).first()).toBeVisible();
    await expect(page.getByText(/se arrastró/)).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goal.id}`;
  }
});

test("a closed month that carried nothing says no «pasó a» — in the report, the month's page and the list (RP-32)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${`Meta sin pase ${Date.now()}`}, ${nextMonth(thisMonth)}::date, 'minutos', 'minutos', (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
    returning id
  `;
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${goal.id}, ${lastMonth}::date, 600)
  `;
  const [done] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${goal.id}, 'Hecha', ${lastMonth}::date, 100) returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${person.id}, ${goal.id}, ${done.id}, ${lastMonth}::date + 14)
  `;

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();

    await page.goto(`/metas/${goal.id}/meses`);
    await expect(page.getByRole("listitem").first()).toContainText(label(lastMonth));
    await expect(page.getByText(/pasó a/)).toHaveCount(0);

    await page.goto(`/metas/${goal.id}/meses/${lastMonth.slice(0, 7)}`);
    await expect(page.getByText(month.list.closed, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/pasó a/)).toHaveCount(0);

    await page.goto("/exportar");
    const main = page.getByRole("main");
    await expect(main.getByText(/Meta sin pase/).first()).toBeVisible();
    await expect(main.getByText("cerrado", { exact: true }).locator("visible=true").first()).toBeVisible();
    await expect(main.getByText(/pasó a/)).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goal.id}`;
  }
});
