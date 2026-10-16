import { test, expect } from "./fixtures";
import { monthOf } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// 655: the button that marks a one-off on Hoy and a task on a goal's month is
// named for its task, so two rows on one screen never share an accessible name.
// The name stays out of sight: nothing new is painted beside the mark.

const today = todayInZone();
const thisMonth = monthOf(today);
const seg = thisMonth.slice(0, 7);
const horizon = `${Number(today.slice(0, 4)) + 1}-${today.slice(5, 7)}-01`;

const SEEN = "Marcar como hecho";

test("Hoy: two one-offs draw two mark buttons, each named «Marcar como hecho: <name>», and the name is not painted (RNP-01)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const first = `Suelta uno ${stamp}`;
  const second = `Suelta dos ${stamp}`;
  await db`insert into goals.one_offs (user_id, name, day) values (${person.id}, ${first}, ${today}::date)`;
  await db`insert into goals.one_offs (user_id, name, day) values (${person.id}, ${second}, ${today}::date)`;
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByText(first, { exact: true })).toBeVisible();
    await expect(page.getByText(second, { exact: true })).toBeVisible();

    await expect(page.getByRole("button", { name: `${SEEN}: ${first}`, exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: `${SEEN}: ${second}`, exact: true })).toHaveCount(1);
    // No mark button on the screen answers to the bare label.
    await expect(page.getByRole("button", { name: SEEN, exact: true })).toHaveCount(0);

    // Nothing visible changes: the label is never painted.
    await expect(page.getByText(SEEN)).toHaveCount(0);
    const text = await page.getByRole("button", { name: `${SEEN}: ${first}`, exact: true }).innerText();
    expect(text.trim()).toBe("");
  } finally {
    await context.close();
  }
});

test("a goal's month: two tasks draw two mark buttons, each named «Marcar como hecho: <name>», and the name is not painted (RNP-01)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const first = `Tarea uno ${stamp}`;
  const second = `Tarea dos ${stamp}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${`Meta marca ${stamp}`}, ${horizon}::date, 'minutos', 'minutos', now() - interval '3 days')
    returning id
  `;
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${goal.id}, ${thisMonth}::date, 600)
  `;
  for (const name of [first, second]) {
    await db`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
      values (${person.id}, ${goal.id}, ${name}, ${thisMonth}::date, 60)
    `;
  }
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goal.id}/meses/${seg}`);
    await expect(page.getByText(first, { exact: true })).toBeVisible();
    await expect(page.getByText(second, { exact: true })).toBeVisible();

    await expect(page.getByRole("button", { name: `${SEEN}: ${first}`, exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: `${SEEN}: ${second}`, exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: SEEN, exact: true })).toHaveCount(0);

    await expect(page.getByText(SEEN)).toHaveCount(0);
    const text = await page.getByRole("button", { name: `${SEEN}: ${first}`, exact: true }).innerText();
    expect(text.trim()).toBe("");
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goal.id}`;
  }
});
