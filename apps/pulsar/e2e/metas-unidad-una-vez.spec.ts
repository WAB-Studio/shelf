import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// `/metas` (`MetasConCifra`, `UnidadUnaVez`): every open goal's row carries this
// month's figure, the unit said once, under the name and above «hasta el …».
// At 360 the phone row grows that line; at 1280 it was already there.
const MONTH_LONG = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const today = todayInZone();
const month = `${today.slice(0, 7)}-01`;
const monthName = MONTH_LONG[Number(today.slice(5, 7)) - 1];

function horizon(): string {
  const date = civilDateToDate(today);
  date.setUTCDate(date.getUTCDate() + 60);
  return dateToCivilDate(date);
}

async function seedGoal(
  db: postgres.Sql,
  personId: string,
  name: string,
  unit: string | null,
): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${name}, ${horizon()}::date, ${unit}, ${unit}, ${new Date(Date.now() - 20 * 86_400_000)})
    returning id
  `;
  return goal.id;
}

async function seedBudget(db: postgres.Sql, personId: string, goalId: string, amount: number) {
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${personId}, ${goalId}, ${month}::date, ${amount})
  `;
}

// A declared quantity today, the way a person writes «34 km».
async function seedReached(
  db: postgres.Sql,
  personId: string,
  goalId: string,
  unit: string,
  quantity: number,
) {
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${personId}, ${goalId}, ${`Hecho ${goalId}`}, 'daily', 'quantity', 10, ${unit}, now() - interval '40 days')
    returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${personId}, ${goalId}, ${commitment.id}, ${today}::date, ${quantity})
  `;
}

// A time goal reaches its figure through a done task's estimate, in minutes.
async function seedMinutes(db: postgres.Sql, personId: string, goalId: string, minutes: number) {
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${personId}, ${goalId}, 'hecha', ${month}::date, ${minutes})
    returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${personId}, ${goalId}, ${task.id}, ${today}::date)
  `;
}

for (const width of [360, 1280]) {
  test(`/metas at ${width}: a word unit is said once, «30 de 60 búsquedas» and «15 de 40 km»`, async ({
    person,
    browser,
    db,
  }) => {
    const stamp = Date.now();
    const vocabulary = `Vocabulario ${stamp}`;
    const running = `Correr ${stamp}`;
    const searchesGoal = await seedGoal(db, person.id, vocabulary, "searches");
    await seedBudget(db, person.id, searchesGoal, 60);
    await seedReached(db, person.id, searchesGoal, "searches", 30);
    const kmGoal = await seedGoal(db, person.id, running, "km");
    await seedBudget(db, person.id, kmGoal, 40);
    await seedReached(db, person.id, kmGoal, "km", 15);

    const context = await browser.newContext({
      storageState: person.sessionFile,
      viewport: { width, height: 900 },
    });
    try {
      const page = await context.newPage();
      await page.goto("/metas");
      const main = page.locator("main");
      const normal = async (name: string) =>
        (await main.locator("a", { hasText: name }).innerText()).replace(/\s+/g, " ");
      expect(await normal(vocabulary)).toContain(`${monthName} · 30 de 60 búsquedas`);
      expect(await normal(running)).toContain(`${monthName} · 15 de 40 km`);
      expect(await normal(vocabulary)).not.toMatch(/30 búsquedas de/);
    } finally {
      await context.close();
    }
  });

  test(`/metas at ${width}: a time unit keeps its «h» on both figures, «2 h de 8 h» and «45 min de 10 h»`, async ({
    person,
    browser,
    db,
  }) => {
    const stamp = Date.now();
    const english = `Inglés ${stamp}`;
    const reading = `Lectura ${stamp}`;
    const englishGoal = await seedGoal(db, person.id, english, "min");
    await seedBudget(db, person.id, englishGoal, 480);
    await seedMinutes(db, person.id, englishGoal, 120);
    const readingGoal = await seedGoal(db, person.id, reading, "min");
    await seedBudget(db, person.id, readingGoal, 600);
    await seedMinutes(db, person.id, readingGoal, 45);

    const context = await browser.newContext({
      storageState: person.sessionFile,
      viewport: { width, height: 900 },
    });
    try {
      const page = await context.newPage();
      await page.goto("/metas");
      const main = page.locator("main");
      const normal = async (name: string) =>
        (await main.locator("a", { hasText: name }).innerText()).replace(/\s+/g, " ");
      expect(await normal(english)).toContain(`${monthName} · 2 h de 8 h`);
      expect(await normal(reading)).toContain(`${monthName} · 45 min de 10 h`);
    } finally {
      await context.close();
    }
  });

  test(`/metas at ${width}: a goal with no amount keeps its unit, «${monthName} · 18 búsquedas»`, async ({
    person,
    browser,
    db,
  }) => {
    const name = `Sin monto ${Date.now()}`;
    const goal = await seedGoal(db, person.id, name, "searches");
    await seedReached(db, person.id, goal, "searches", 18);

    const context = await browser.newContext({
      storageState: person.sessionFile,
      viewport: { width, height: 900 },
    });
    try {
      const page = await context.newPage();
      await page.goto("/metas");
      const row = (await page.locator("main a", { hasText: name }).innerText()).replace(/\s+/g, " ");
      expect(row).toContain(`${monthName} · 18 búsquedas`);
      expect(row).not.toContain(" de ");
    } finally {
      await context.close();
    }
  });

  test(`/metas at ${width}: one search with no amount says it in the singular, «${monthName} · 1 búsqueda»`, async ({
    person,
    browser,
    db,
  }) => {
    const name = `Una sola ${Date.now()}`;
    const goal = await seedGoal(db, person.id, name, "searches");
    await seedReached(db, person.id, goal, "searches", 1);

    const context = await browser.newContext({
      storageState: person.sessionFile,
      viewport: { width, height: 900 },
    });
    try {
      const page = await context.newPage();
      await page.goto("/metas");
      const row = (await page.locator("main a", { hasText: name }).innerText()).replace(/\s+/g, " ");
      expect(row).toContain(`${monthName} · 1 búsqueda`);
      expect(row).not.toContain("1 búsquedas");
    } finally {
      await context.close();
    }
  });
}

test("/metas at 360: the month figure sits under the name and above «hasta el …»; ended and archived rows and a goal with no measure draw none", async ({
  person,
  browser,
  db,
}) => {
  const stamp = Date.now();
  const measured = `Con cifra ${stamp}`;
  const bare = `Libre ${stamp}`;
  const ended = `Terminada ${stamp}`;
  const archived = `Archivada ${stamp}`;
  const goal = await seedGoal(db, person.id, measured, "searches");
  await seedBudget(db, person.id, goal, 60);
  await seedReached(db, person.id, goal, "searches", 30);
  await seedGoal(db, person.id, bare, null);
  const [endedGoal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${ended}, '2026-09-14', 'searches', 'searches', ${new Date(Date.now() - 60 * 86_400_000)})
    returning id
  `;
  await seedBudget(db, person.id, endedGoal.id, 60);
  const archivedGoal = await seedGoal(db, person.id, archived, "searches");
  await seedBudget(db, person.id, archivedGoal, 60);
  await db`update goals.goals set archived_at = now() where id = ${archivedGoal}`;

  const context = await browser.newContext({
    storageState: person.sessionFile,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/metas");
    const main = page.locator("main");
    const row = main.locator("a", { hasText: measured });
    const figure = row.getByText(`${monthName} · 30 de 60 búsquedas`).locator("visible=true");
    const until = row.getByText(/^hasta el /).locator("visible=true");
    const name = row.getByText(measured, { exact: true });
    await expect(figure).toBeVisible();
    const y = async (locator: typeof figure) => (await locator.boundingBox())!.y;
    expect(await y(name)).toBeLessThan(await y(figure));
    expect(await y(figure)).toBeLessThan(await y(until));

    const bareText = (await main.locator("a", { hasText: bare }).innerText()).replace(/\s+/g, " ");
    expect(bareText).not.toContain(monthName);
    expect(bareText).toContain("hasta el");
    for (const other of [ended, archived]) {
      expect(await main.locator("a", { hasText: other }).innerText()).not.toContain(monthName);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  } finally {
    await context.close();
  }
});
