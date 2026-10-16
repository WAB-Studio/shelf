import type { Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { todayInZone } from "@/lib/zone";

// `HoySiguienteCifra` (RP-28, RP-30, RP-54): Hoy's «este mes» row
// for the next task of the plan says one hour figure and never a 0. A whole
// task trails its estimate and the line carries no figure; a task with none
// trails «sin estimar» in a time goal and nothing in a km one (RP-65); a sub-task never shows its parent's share; only a task
// split across months reads «Siguiente del plan · 10 h este mes».

const letters = (n: number) => [...String(n)].map((digit) => String.fromCharCode(97 + Number(digit))).join("");

async function seedGoal(
  db: postgres.Sql,
  personId: string,
  name: string,
  measure: { unit: string; rhythm: number } | null,
) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${personId}, ${name}, '2099-12-31'::date, ${measure?.unit ?? null}, ${measure?.unit ?? null},
            ${measure?.rhythm ?? null}, '2020-01-01T00:00:00Z'::timestamptz)
    returning id
  `;
  return goal.id;
}

async function planTask(db: postgres.Sql, personId: string, goalId: string, name: string, estimate: number | null) {
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, estimate, in_plan, position, created_at)
    values (${personId}, ${goalId}, ${name}, ${estimate}, true, 1, '2020-01-02T00:00:00Z'::timestamptz)
    returning id
  `;
  return task.id;
}

// The row of the task: the mark that completes it sits directly in the row.
function rowOf(page: Page, name: string): Locator {
  return page.getByRole("button", { name: `Marcar hecha: ${name}` }).locator("visible=true").locator("xpath=..");
}

const WIDTHS = [390, 1440];

for (const width of WIDTHS) {
  test(`Hoy at ${width}: in minutes a next task with no estimate trails «sin estimar» muted, one with a figure trails it, and neither draws a 0`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const minutesName = `Sin cifra minutos ${stamp}`;
    const sizedName = `Con cifra ${stamp}`;
    const halfName = `Hora y media ${stamp}`;
    const minutes = await seedGoal(db, person.id, `Meta minutos ${stamp}`, { unit: "minutos", rhythm: 600 });
    await planTask(db, person.id, minutes, minutesName, null);
    const sized = await seedGoal(db, person.id, `Meta con cifra ${stamp}`, { unit: "minutos", rhythm: 600 });
    await planTask(db, person.id, sized, sizedName, 240);
    const half = await seedGoal(db, person.id, `Meta hora y media ${stamp}`, { unit: "minutos", rhythm: 600 });
    await planTask(db, person.id, half, halfName, 90);

    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      const row = rowOf(page, minutesName);
      await expect(row, "the row is drawn").toBeVisible();
      await expect.soft(row.getByText("sin estimar", { exact: true }), "trails «sin estimar»").toHaveCount(1);
      const text = await row.innerText();
      expect.soft(text, "no 0 anywhere in the row").not.toMatch(/\b0\s*(km|min|h|kil)/i);
      expect.soft(text, "no figure in the line").not.toContain("·");
      await expect(rowOf(page, halfName).getByText("1 h 30 min", { exact: true }), "a figure trails as is").toHaveCount(1);
      expect.soft(await rowOf(page, halfName).innerText(), "no «sin estimar» beside a figure").not.toContain("sin estimar");
      const unsized = await row.getByText("sin estimar", { exact: true }).evaluate((el) => {
        const c = getComputedStyle(el);
        return [c.color, c.fontSize, c.fontFamily, c.fontWeight];
      });
      const sizedTrail = await rowOf(page, sizedName).getByText("4 h", { exact: true }).evaluate((el) => {
        const c = getComputedStyle(el);
        return [c.color, c.fontSize, c.fontFamily, c.fontWeight];
      });
      expect(unsized, "«sin estimar» is as muted and as big as an estimate").toEqual(sizedTrail);
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });

  test(`Hoy at ${width}: a task of a goal measured in km carries nothing on its right, with or without a stored figure`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const bareName = `Trote ${letters(stamp)}`;
    const sizedName = `Carrera ${letters(stamp)}`;
    const bare = await seedGoal(db, person.id, `Meta km ${stamp}`, { unit: "kilómetros", rhythm: 20 });
    await planTask(db, person.id, bare, bareName, null);
    const sized = await seedGoal(db, person.id, `Meta km cifra ${stamp}`, { unit: "kilómetros", rhythm: 20 });
    await planTask(db, person.id, sized, sizedName, 5);

    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      for (const name of [bareName, sizedName]) {
        const row = rowOf(page, name);
        await expect(row, `${name}: the row is drawn`).toBeVisible();
        await expect(row.getByText(/^Siguiente del (plan|mes)$/), `${name}: its sentence stays`).toHaveCount(1);
        const text = await row.innerText();
        expect.soft(text, `${name}: no «sin estimar»`).not.toContain("sin estimar");
        expect.soft(text, `${name}: no figure at all`).not.toMatch(/\d/);
        expect.soft(text, `${name}: no unit`).not.toMatch(/km|kil/i);
      }
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });

  test(`Hoy at ${width}: marking a km task completes it and brings the next one`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const firstName = `Km primera ${stamp}`;
    const secondName = `Km segunda ${stamp}`;
    const goal = await seedGoal(db, person.id, `Meta km marca ${stamp}`, { unit: "kilómetros", rhythm: 20 });
    const firstId = await planTask(db, person.id, goal, firstName, null);
    await db`
      insert into goals.one_offs (user_id, goal_id, name, in_plan, position, created_at)
      values (${person.id}, ${goal}, ${secondName}, true, 2, '2020-01-03T00:00:00Z'::timestamptz)
    `;

    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      await expect(rowOf(page, firstName)).toBeVisible();
      await page.getByRole("button", { name: `Marcar hecha: ${firstName}` }).locator("visible=true").click();
      await expect(rowOf(page, secondName), "the next task comes in").toBeVisible();
      await expect(page.getByRole("button", { name: `Marcar hecha: ${firstName}` })).toHaveCount(0);
      const [done] = await db<{ n: string }[]>`
        select count(*)::text as n from goals.facts where one_off_id = ${firstId}
      `;
      expect(done.n, "completeOneOff wrote the first task's fact").toBe("1");
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });

  test(`Hoy at ${width}: a sub-task says «de <parent>», its own hour once and never the parent's share`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const parent = `Libro ${letters(stamp)}`;
    const goal = await seedGoal(db, person.id, `Meta libro ${stamp}`, { unit: "minutos", rhythm: 600 });
    const parentId = await planTask(db, person.id, goal, parent, null);
    await db`
      insert into goals.one_offs (user_id, goal_id, parent_id, name, estimate, position)
      values (${person.id}, ${goal}, ${parentId}, ${`Cap. 1 ${stamp}`}, 60, 1),
             (${person.id}, ${goal}, ${parentId}, ${`Cap. 2 ${stamp}`}, 120, 2)
    `;
    // A parent split across months: this month holds 10 h of its 30 h, and the
    // next chapter is 20 h. The 10 h is the parent's share, never the chapter's.
    const wide = `Tomo ${letters(stamp)}`;
    const wideGoal = await seedGoal(db, person.id, `Meta tomo ${stamp}`, { unit: "minutos", rhythm: 600 });
    const wideId = await planTask(db, person.id, wideGoal, wide, null);
    await db`
      insert into goals.one_offs (user_id, goal_id, parent_id, name, estimate, position)
      values (${person.id}, ${wideGoal}, ${wideId}, ${`Parte 1 ${stamp}`}, 1200, 1),
             (${person.id}, ${wideGoal}, ${wideId}, ${`Parte 2 ${stamp}`}, 600, 2)
    `;

    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      const row = rowOf(page, `Cap. 1 ${stamp}`);
      await expect(row).toBeVisible();
      await expect.soft(row.getByText(`de ${parent}`, { exact: true }), "«de <parent>» above").toHaveCount(1);
      const text = await row.innerText();
      expect.soft(text.match(/\b1 h\b/g)?.length ?? 0, "its own hour, once").toBe(1);
      expect.soft(text, "never the parent's share").not.toMatch(/\b3 h\b/);
      expect.soft(text, "the line carries no figure").not.toContain("·");

      const wideRow = rowOf(page, `Parte 1 ${stamp}`);
      await expect(wideRow).toBeVisible();
      await expect.soft(wideRow.getByText(`de ${wide}`, { exact: true })).toHaveCount(1);
      const wideText = await wideRow.innerText();
      expect.soft(wideText.match(/\b20 h\b/g)?.length ?? 0, "the chapter's own 20 h, once").toBe(1);
      expect.soft(wideText, "the parent's 10 h this month never shows on the chapter").not.toMatch(/\b10 h\b/);
      expect.soft(wideText, "no share line on a sub-task").not.toContain("este mes");
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });

  test(`Hoy at ${width}: a whole task within the month says its estimate once and «Siguiente del plan» with no figure`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const name = `Entera ${letters(stamp)}`;
    const goal = await seedGoal(db, person.id, `Meta entera ${stamp}`, { unit: "minutos", rhythm: 600 });
    await planTask(db, person.id, goal, name, 240);

    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      const row = rowOf(page, name);
      await expect(row).toBeVisible();
      const text = await row.innerText();
      expect.soft(text.match(/\b4 h\b/g)?.length ?? 0, "«4 h» once in the row").toBe(1);
      await expect.soft(row.getByText("Siguiente del plan", { exact: true }), "the line with no figure").toHaveCount(1);
      expect.soft(text, "no month share on a whole task").not.toContain("este mes");
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });

  test(`Hoy at ${width}: a task split across months trails its estimate and the line says this month's share, figure mono, line Archivo`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const name = `Partida ${letters(stamp)}`;
    const goal = await seedGoal(db, person.id, `Meta partida ${stamp}`, { unit: "minutos", rhythm: 600 });
    await planTask(db, person.id, goal, name, 1800);

    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      const row = rowOf(page, name);
      await expect(row).toBeVisible();
      await expect.soft(row.getByText("30 h", { exact: true }), "trails its estimate").toHaveCount(1);
      const line = row.getByText(/^Siguiente del plan/);
      await expect(line, "the line").toHaveCount(1);
      await expect.soft(line).toHaveText("Siguiente del plan · 10 h este mes");
      const figure = row.getByText("10 h", { exact: true });
      await expect(figure, "the share is its own element").toHaveCount(1);
      expect.soft(await figure.evaluate((el) => getComputedStyle(el).fontFamily), "figure mono").toMatch(/mono/i);
      expect.soft(await line.evaluate((el) => getComputedStyle(el).fontFamily), "line Archivo").not.toMatch(/mono/i);
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });

  test(`Hoy at ${width}: a goal with no measure draws no figure and no «sin estimar»`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const name = `Trasteo ${letters(stamp)}`;
    const goal = await seedGoal(db, person.id, `Meta sin medida ${stamp}`, null);
    const month = `${todayInZone().slice(0, 7)}-01`;
    await db`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, position)
      values (${person.id}, ${goal}, ${name}, ${month}::date, 1)
    `;

    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      const row = rowOf(page, name);
      await expect(row).toBeVisible();
      const text = await row.innerText();
      expect.soft(text, "no «sin estimar» without a measure").not.toContain("sin estimar");
      expect.soft(text, "no figure at all").not.toMatch(/\d/);
      expect.soft(text, "no share in the line").not.toContain("·");
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });
}

test("Hoy at 360: a 40-letter task name that is split across months never widens the page", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const name = "Larguisimanombredetareasinespaciosquellena";
  const goal = await seedGoal(db, person.id, `Meta ancha ${Date.now()}`, { unit: "minutos", rhythm: 600 });
  await planTask(db, person.id, goal, name, 1800);

  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("main")).toHaveCount(1);
    await expect(rowOf(page, name).getByText("Siguiente del plan · 10 h este mes")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});
