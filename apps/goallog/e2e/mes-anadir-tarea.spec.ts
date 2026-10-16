import { boxOf } from "./box";
import { test, expect } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// `MesAñadirTarea` (RP-30, RP-31), decided by the user 2026-10-14: in Mes, a goal that
// has tasks closes its card with «Añadir una tarea», as a goal with none does today;
// a goal with no amount this month still sends to «Planear {mes}».

const NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const today = todayInZone();
const thisMonth = monthOf(today);
const lastMonth = monthOf(dayBefore(thisMonth));
const seg = thisMonth.slice(0, 7);
const monthName = NAMES[Number(seg.slice(5, 7)) - 1];
const horizon = `${Number(today.slice(0, 4)) + 1}-${today.slice(5, 7)}-01`;

type Db = import("postgres").Sql;

async function seedGoal(db: Db, personId: string, name: string, order: number) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${name}, ${horizon}::date, 'minutos', 'minutos',
            (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC' + ${`${order} minutes`}::interval)
    returning id
  `;
  return goal.id;
}

async function seedTask(db: Db, personId: string, goalId: string, name: string) {
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${personId}, ${goalId}, ${name}, ${thisMonth}::date, 30)
  `;
}

test("Mes: a goal with tasks ends its card with «Añadir una tarea»; one with no amount keeps «Planear {mes}» (RP-30)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const leer = await seedGoal(db, person.id, "Leer", 0);
  await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${leer}, ${thisMonth}::date, 600)`;
  for (const name of ["Capítulo uno", "Capítulo dos", "Capítulo tres"]) await seedTask(db, person.id, leer, name);
  const cocinar = await seedGoal(db, person.id, "Cocinar", 1);
  await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${cocinar}, ${thisMonth}::date, 300)`;
  // A goal with no amount this month, measured: «Planear {mes}» stays its link.
  const correr = await seedGoal(db, person.id, "Correr", 2);
  await seedTask(db, person.id, correr, "Salir a correr");

  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await page.goto("/mes");
    const card = (name: string) => page.locator("section", { has: page.getByRole("heading", { name }) });
    const add = (name: string) => card(name).getByRole("link", { name: "Añadir una tarea", exact: true });

    // Where it already stood: a goal with none.
    await expect(add("Cocinar")).toHaveAttribute("href", `/metas/${cocinar}/meses/${seg}/tarea/nueva`);

    // A goal with no amount: «Planear {mes}», and not the add link.
    await expect(card("Correr").getByRole("link", { name: `Planear ${monthName}`, exact: true })).toBeVisible();
    await expect(add("Correr")).toHaveCount(0);

    // A goal with tasks: the link is there, goes to its new-task page, and closes the card.
    await expect(add("Leer")).toBeVisible();
    await expect(add("Leer")).toHaveAttribute("href", `/metas/${leer}/meses/${seg}/tarea/nueva`);
    const last = await boxOf(card("Leer").getByText("Capítulo tres"));
    expect((await boxOf(add("Leer"))).y).toBeGreaterThan(last.y);
    const next = await boxOf(page.getByRole("heading", { name: "Cocinar" }));
    expect((await boxOf(add("Leer"))).y).toBeLessThan(next.y);

    await expect(page.getByRole("link", { name: "Añadir una tarea", exact: true })).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    // The link opens the form of that goal's month.
    await add("Leer").click();
    await expect(page).toHaveURL(new RegExp(`/metas/${leer}/meses/${seg}/tarea/nueva$`));
  } finally {
    await context.close();
  }
});
