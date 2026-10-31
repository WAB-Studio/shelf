import type { Browser } from "@playwright/test";
import type postgres from "postgres";

import { horizonForWeeks } from "@/lib/day/weeks";
import { todayInZone } from "@/lib/zone";

import { test, expect, openMore } from "./fixtures";
import { boxOf } from "./box";

// Module 900, clause 5 (board CrearDentroAviso): the create-inside sheet says the upper goal's rhythm stops
// counting, only when it has one, and the new goal measures in the parent's unit.

type Db = postgres.Sql;

async function seedPair(db: Db, personId: string, name: string, rhythm: number | null) {
  const [general] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon) values (${personId}, ${`General ${name}`}, ${horizonForWeeks(todayInZone(), 30)}::date)
    returning id`;
  const [large] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, parent_id, measure_name, measure_unit, rhythm)
    values (${personId}, ${name}, ${horizonForWeeks(todayInZone(), 11)}::date, ${general.id}, 'estudio', 'minutos', ${rhythm})
    returning id`;
  return large.id;
}

async function openSheet(browser: Browser, baseURL: string, sessionFile: string, goalId: string) {
  const context = await browser.newContext({ storageState: sessionFile, baseURL, viewport: { width: 360, height: 900 } });
  const page = await context.newPage();
  await page.goto(`/metas/${goalId}`);
  await openMore(page);
  await page.getByRole("button", { name: "Añadir meta pequeña" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  return { context, page, sheet };
}

const lineOf = (name: string) => `El ritmo al mes de «${name}» deja de contar; la meta nueva mide como ella.`;

test("on a goal with a rhythm the sheet says it stops counting, above «Abrirla»; the new goal measures in the parent's unit", async ({ person, browser, baseURL, db }) => {
  // Kills: no warning line; line placed after the buttons; createGoal not carrying the parent's unit (the new goal «no mide nada»).
  const name = `Diseño ${Date.now()}`;
  const parentId = await seedPair(db, person.id, name, 720);
  const { context, page, sheet } = await openSheet(browser, baseURL!, person.sessionFile, parentId);
  try {
    const line = sheet.getByText(lineOf(name), { exact: true });
    await expect(line).toBeVisible();
    const open = sheet.getByRole("button", { name: "Abrirla", exact: true });
    expect((await boxOf(line)).y).toBeLessThan((await boxOf(open)).y);

    const child = `Línea base ${Date.now()}`;
    await sheet.getByLabel("nombre").fill(child);
    await sheet.getByLabel(/^semanas, contando la del /i).fill("4");
    await open.click();
    await page.waitForURL((url) => /\/metas\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(parentId));
    await expect(page.getByRole("main").getByText(child, { exact: true })).toBeVisible();
    await expect(page.getByText("esta meta no mide nada")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("on a goal with no rhythm the sheet draws no such line", async ({ person, browser, baseURL, db }) => {
  // Kills: the line shown for every goal, not only those with a rhythm.
  const name = `Sin ritmo ${Date.now()}`;
  const parentId = await seedPair(db, person.id, name, null);
  const { context, sheet } = await openSheet(browser, baseURL!, person.sessionFile, parentId);
  try {
    await expect(sheet.getByRole("button", { name: "Abrirla", exact: true })).toBeVisible();
    await expect(sheet.getByText("deja de contar")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
