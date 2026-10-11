import { test, expect, type Person } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import type { Page } from "@playwright/test";
import type postgres from "postgres";

// RP-71, RP-58, RP-17 (module 814): a month row says its state once, on the phone and on the card; an ended goal
// has no «Esta semana» and no week «en curso».
const NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const startOf = (offset: number) => {
  const date = civilDateToDate(`${todayInZone().slice(0, 7)}-01`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return dateToCivilDate(date);
};
const nameOf = (offset: number) => NAMES[Number(startOf(offset).slice(5, 7)) - 1];

// Last month closes with 25 % carried (60 of 240 min undone), this one is open, the next only plans.
async function seedMonths(db: postgres.Sql, person: Person) {
  const stamp = Date.now();
  const name = `Estado una vez ${stamp}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${name}, ${startOf(3)}, 'horas de estudio', 'minutos', now() - interval '70 days')
    returning id
  `;
  for (const [offset, amount] of [[-1, 720], [0, 600], [1, 1200], [2, 720]] as const) {
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${goal.id}, ${startOf(offset)}::date, ${amount})
    `;
  }
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${goal.id}, ${`Estudio ${stamp}`}, 'daily', 'quantity', 30, 'minutos', now() - interval '70 days')
    returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${person.id}, ${goal.id}, ${commitment.id}, ${`${startOf(-1).slice(0, 7)}-10`}::date, 360),
           (${person.id}, ${goal.id}, ${commitment.id}, ${todayInZone()}::date, 165)
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, estimate, planned_month)
    values (${person.id}, ${goal.id}, ${`Debida ${stamp}`}, 60, ${startOf(-1)}::date)
  `;
  const [before] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, estimate, planned_month)
    values (${person.id}, ${goal.id}, ${`Hecha antes ${stamp}`}, 180, ${startOf(-1)}::date)
    returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${person.id}, ${goal.id}, ${before.id}, ${`${startOf(-1).slice(0, 7)}-10`}::date)
  `;
  return { goalId: goal.id, name };
}

async function openReport(page: Page, name: string) {
  await page.goto("/exportar");
  await expect(page.getByText(`${name} · por mes`, { exact: true })).toBeVisible();
  return page.locator("section", { has: page.getByText(`${name} · por mes`, { exact: true }) }).last();
}

const count = (text: string, word: string) => text.split(word).length - 1;
const rowText = (rows: import("@playwright/test").Locator) => rows.evaluateAll((all) => all.map((row) => (row as HTMLElement).innerText.replace(/\s+/g, " ")));

test.describe("a month row says its state once (RP-71)", () => {
  for (const width of [360, 1024, 1440] as const) {
    test(`at ${width} the current month says «en curso» once and keeps «de 10 h»`, async ({ person, browser, baseURL, db }) => {
      const months = await seedMonths(db, person);
      const context = await browser.newContext({
        storageState: person.sessionFile,
        baseURL: baseURL!,
        viewport: { width, height: 900 },
      });
      try {
        const page = await context.newPage();
        const section = await openReport(page, months.name);
        const current = section.locator("[data-current]:visible");
        await expect(current).toHaveCount(1);
        const [text] = await rowText(current);
        expect(count(text, "en curso"), text).toBe(1);
        if (width < 700) expect(text).toContain("de 10 h");
      } finally {
        await context.close();
        await db`delete from goals.goals where id = ${months.goalId} and user_id = ${person.id}`;
      }
    });
  }

  for (const width of [360, 1024] as const) {
    test(`at ${width} the closed month says «cerrado · 25 % pasó a ${nameOf(0)}» once`, async ({ person, browser, baseURL, db }) => {
      const months = await seedMonths(db, person);
      const context = await browser.newContext({
        storageState: person.sessionFile,
        baseURL: baseURL!,
        viewport: { width, height: 900 },
      });
      try {
        const page = await context.newPage();
        const section = await openReport(page, months.name);
        const closed = section.locator("li:visible, tbody tr:visible", { hasText: /\d+ % pasó a/ });
        await expect(closed).toHaveCount(1);
        const [text] = await rowText(closed);
        expect(count(text, "cerrado"), text).toBe(1);
        expect(count(text, "% pasó a"), text).toBe(1);
        expect(text).toContain(`cerrado · 25 % pasó a ${nameOf(0)}`);
        if (width < 700) expect(text).toContain("de 12 h");
      } finally {
        await context.close();
        await db`delete from goals.goals where id = ${months.goalId} and user_id = ${person.id}`;
      }
    });
  }

  test("at 360 the future month still reads «20 h planeado»", async ({ person, browser, baseURL, db }) => {
    const months = await seedMonths(db, person);
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width: 360, height: 900 },
    });
    try {
      const page = await context.newPage();
      const section = await openReport(page, months.name);
      const future = section.locator("li:visible", { hasText: nameOf(1) });
      await expect(future).toHaveCount(1);
      const [text] = await rowText(future);
      expect(text).toContain("20 h planeado");
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${months.goalId} and user_id = ${person.id}`;
    }
  });
});

test.describe("an ended goal's report does not say this week (RP-17, RP-58)", () => {
  for (const width of [390, 1440] as const) {
    test(`at ${width} it has no «Esta semana», no weeks and no «en curso»`, async ({
      person,
      browser,
      baseURL,
      db,
    }) => {
      const stamp = Date.now();
      const name = `Meta terminada ${stamp}`;
      // Horizon today: the goal ended, its last day is yesterday.
      const [goal] = await db<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
        values (${person.id}, ${name}, ${todayInZone()}, 'horas de estudio', 'minutos', now() - interval '40 days')
        returning id
      `;
      await db`
        insert into goals.month_budgets (user_id, goal_id, month, amount)
        values (${person.id}, ${goal.id}, ${startOf(0)}::date, 720)
      `;
      const [commitment] = await db<{ id: string }[]>`
        insert into goals.commitments
          (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
        values (${person.id}, ${goal.id}, ${`Estudio ${stamp}`}, 'daily', 'quantity', 30, 'minutos', now() - interval '40 days')
        returning id
      `;
      await db`
        insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
        values (${person.id}, ${goal.id}, ${commitment.id}, ${dayBefore(todayInZone())}::date, 90)
      `;
      const context = await browser.newContext({
        storageState: person.sessionFile,
        baseURL: baseURL!,
        viewport: { width, height: 900 },
      });
      try {
        const page = await context.newPage();
        await page.goto("/exportar");
        const dayName = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
        await expect(
          page.getByText(`terminada el ${dayName.format(civilDateToDate(dayBefore(todayInZone())))}`, { exact: true }),
        ).toBeVisible();
        // The goal's own block: the nearest ancestor of its heading that holds its end line.
        const whole = await page.getByRole("main").evaluate((main, goalName) => {
          const heading = [...main.querySelectorAll("h2")].find((h) => h.textContent === goalName)!;
          let node: HTMLElement = heading.parentElement!;
          while (!node.textContent!.includes("terminada el")) node = node.parentElement!;
          return (node.textContent ?? "").replace(/\s+/g, " ");
        }, name);
        for (const word of ["Esta semana", "por semana", "en curso", "sem "]) expect(whole).not.toContain(word);
      } finally {
        await context.close();
        await db`delete from goals.goals where id = ${goal.id} and user_id = ${person.id}`;
      }
    });
  }
});
