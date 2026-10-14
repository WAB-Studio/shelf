import type { Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import { dateToCivilDate, todayInZone } from "@/lib/zone";

import { test, expect, type Person } from "./fixtures";

// RP-14, RP-28: the figure beside «mide en horas y minutos» (RP-35, RP-66) is the goal's total since
// it opened, and a quiet line under it says so: «en total, desde el 1 de
// enero» (`MetaTotal`). The date is DM Mono inside an
// Archivo sentence; the year shows only when it is not the current one. «0 min»
// stays at zero, and a goal with no measure draws neither figure nor line.

const WIDTHS: [number, number][] = [
  [390, 844],
  [1440, 900],
];

const LINE = /^en total, desde el /;

// Noon in Bogotá, so the opening day is the same civil day in the zone.
function openedAt(year: number): Date {
  return new Date(`${year}-01-01T17:00:00Z`);
}

async function seedGoal(
  db: postgres.Sql,
  person: Person,
  opts: { openedYear: number; measured: boolean; minutes: number; unit?: string },
): Promise<{ goalId: string }> {
  const horizon = dateToCivilDate(new Date(Date.now() + 90 * 86_400_000));
  const opened = openedAt(opts.openedYear);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${`Meta total ${Date.now()}`}, ${horizon}::date,
            ${opts.measured ? "Estudio" : null}, ${opts.measured ? (opts.unit ?? "minutos") : null}, ${opened})
    returning id
  `;
  if (opts.measured) {
    const [commitment] = await db<{ id: string }[]>`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goal.id}, ${`Estudio ${Date.now()}`}, 'daily', 'quantity', 60, ${opts.unit ?? "minutos"}, ${opened})
      returning id
    `;
    if (opts.minutes > 0) {
      await db`
        insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
        values (${person.id}, ${goal.id}, ${commitment.id}, ${todayInZone()}::date, ${opts.minutes})
      `;
    }
  }
  return { goalId: goal.id };
}

async function lineParts(line: Locator) {
  return line.evaluate((el) => ({
    text: el.textContent ?? "",
    family: getComputedStyle(el).fontFamily,
    spans: Array.from(el.querySelectorAll("span")).map((span) => ({
      text: span.textContent ?? "",
      family: getComputedStyle(span).fontFamily,
    })),
  }));
}

function totalLine(page: Page): Locator {
  return page.locator("p", { hasText: LINE }).locator("visible=true");
}

for (const [width, height] of WIDTHS) {
  test(`at ${width}px a measured goal names its figure the total since it opened`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const year = Number(todayInZone().slice(0, 4));
    const { goalId } = await seedGoal(db, person, { openedYear: year, measured: true, minutes: 890 });
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width, height },
    });
    try {
      const page = await context.newPage();
      await page.goto(`/metas/${goalId}`);
      await expect(page.getByText("mide Estudio, en horas y minutos", { exact: true })).toBeVisible();
      await expect(page.getByText("mide en minutos", { exact: true })).toHaveCount(0);

      // Names the total, with the board's words.
      const line = totalLine(page);
      await expect(line).toHaveCount(1);
      await expect(line).toHaveText("en total, desde el 1 de enero");

      // Sits under the figure, not above it or beside the sentence.
      const figure = page.getByText(/^14 h 50 min$/).locator("visible=true").first();
      await expect(figure).toBeVisible();
      const figureBox = (await figure.boundingBox())!;
      const lineBox = (await line.boundingBox())!;
      expect(lineBox.y).toBeGreaterThanOrEqual(figureBox.y + figureBox.height - 1);

      // The date is mono, the rest of the sentence is not.
      const parts = await lineParts(line);
      expect(parts.family).not.toMatch(/mono/i);
      // One span, the whole date: the words «en total, desde el» stay outside it.
      expect(parts.spans.map((s) => s.text)).toEqual(["1 de enero"]);
      expect(parts.spans[0].family).toMatch(/mono/i);

      // The current year is never printed.
      expect(parts.text).not.toMatch(/\d{4}/);
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
    }
  });
}

test("a goal opened in another year carries that year in its mono date", async ({ person, browser, baseURL, db }) => {
  const lastYear = Number(todayInZone().slice(0, 4)) - 1;
  const { goalId } = await seedGoal(db, person, { openedYear: lastYear, measured: true, minutes: 890 });
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goalId}`);
    const line = totalLine(page);
    await expect(line).toHaveCount(1);
    await expect(line).toContainText(`1 de enero`);
    const parts = await lineParts(line);
    expect(parts.text).toContain(String(lastYear));
    // The year belongs to the date: it sits inside the mono span.
    expect(parts.spans.map((s) => s.text)).toEqual([`1 de enero de ${lastYear}`]);
    expect(parts.spans[0].family).toMatch(/mono/i);
    expect(parts.family).not.toMatch(/mono/i);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});

test("a measured goal with nothing done keeps «0 min» and its line", async ({ person, browser, baseURL, db }) => {
  const year = Number(todayInZone().slice(0, 4));
  const { goalId } = await seedGoal(db, person, { openedYear: year, measured: true, minutes: 0 });
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText("mide Estudio, en horas y minutos", { exact: true })).toBeVisible();
    await expect(page.getByText("mide en minutos", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/^0 min$/).locator("visible=true").first()).toBeVisible();
    await expect(totalLine(page)).toHaveText("en total, desde el 1 de enero");
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});

test("a goal with no measure draws no total line and no «mide en»", async ({ person, browser, baseURL, db }) => {
  const year = Number(todayInZone().slice(0, 4));
  const { goalId } = await seedGoal(db, person, { openedYear: year, measured: false, minutes: 0 });
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText("esta meta no mide nada", { exact: true })).toBeVisible();
    await expect(page.getByText("mide en", { exact: false })).toHaveCount(0);
    await expect(page.getByText(/en total/)).toHaveCount(0);
    await expect(page.getByText(/desde el \d/)).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});

// Module 720. A measure kept in minutes is named as its figures read.
test("a goal made with «2 horas» says «mide en horas y minutos», never «mide en minutos»", async ({
  page,
  db,
  personId,
}) => {
  const goalName = `Meta horas ${Date.now()}`;
  await page.goto("/metas/nueva");
  await page.getByLabel("nombre").fill(goalName);
  await page.getByRole("button", { name: "Abrirla" }).click();
  await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
  const goalId = page.url().split("/metas/")[1];
  try {
    await page.getByRole("link", { name: "Añadir un compromiso" }).click();
    await page.waitForURL(`**/metas/${goalId}/compromisos/nuevo`);
    await page.getByLabel("qué es").fill(`Estudio horas ${Date.now()}`);
    await page.getByRole("button", { name: "un número", exact: true }).click();
    await page.getByLabel("cantidad", { exact: true }).fill("2");
    await page.getByLabel("unidad").fill("horas");
    await page.getByRole("button", { name: "Añadirlo" }).click();
    await page.waitForURL(`**/metas/${goalId}`);

    const [row] = await db<{ measure_unit: string }[]>`select measure_unit from goals.goals where id = ${goalId}`;
    expect(row.measure_unit).toBe("minutos");

    for (const [width, height] of WIDTHS) {
      await page.setViewportSize({ width, height });
      await page.goto(`/metas/${goalId}`);
      await expect(page.getByText("mide en horas y minutos", { exact: true })).toBeVisible();
      await expect(page.getByText("mide en minutos", { exact: true })).toHaveCount(0);
    }
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("a goal whose unit is stored as «min» says «mide en horas y minutos»", async ({ person, browser, baseURL, db }) => {
  const year = Number(todayInZone().slice(0, 4));
  const { goalId } = await seedGoal(db, person, { openedYear: year, measured: true, minutes: 90, unit: "min" });
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText("mide Estudio, en horas y minutos", { exact: true })).toBeVisible();
    await expect(page.getByText("mide en min", { exact: true })).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});

test("a goal measured in km keeps «mide en km» (guard, green today)", async ({ person, browser, baseURL, db }) => {
  const year = Number(todayInZone().slice(0, 4));
  const { goalId } = await seedGoal(db, person, { openedYear: year, measured: true, minutes: 5, unit: "km" });
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText("mide Estudio, en km", { exact: true })).toBeVisible();
    await expect(page.getByText("mide en horas y minutos")).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});

// A commitment stored with its weekdays unsorted reads Monday first, as a sentence.
test("the goal screen reads a commitment's weekdays Monday first, joined with «y»", async ({ person, browser, baseURL, db }) => {
  const year = Number(todayInZone().slice(0, 4));
  const { goalId } = await seedGoal(db, person, { openedYear: year, measured: false, minutes: 0 });
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_weekdays, satisfaction)
    values (${person.id}, ${goalId}, ${`Laboratorio ${Date.now()}`}, 'weekdays', '{7,3,1}', 'tap')
  `;
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText("lunes, miércoles y domingo", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("domingo, miércoles, lunes")).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});
