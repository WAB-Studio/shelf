import type { Page } from "@playwright/test";

import { test, expect } from "./fixtures";
import { MONTH_LONG, monthsAhead } from "./meta-arbol-seed";
import { seedOpenGoal, visit, MINUTES } from "./metas-sin-final-seed";

import type { Db } from "./meta-arbol-seed";
import type { Person } from "./fixtures";

// Module 994, board MesesContenedora (Hostile 4, approved 2026-10-14): «Por mes» of a goal that holds goals draws every month in ONE table,
// in order, and never says «estos meses con monto propio:» — a holder keeps no amounts of its own (RP-80), so no month is «propio».
// A goal with no goals inside keeps the second table and its label. The «N de M meses» count is the number of rows drawn.
// Months are relative to today. Dec/Jan/Feb of the board are the 2nd, 3rd and 4th month ahead.

test.use({ actionTimeout: 6000 });

const label = (month: string) => `${MONTH_LONG[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const AHEAD = [2, 3, 4].map(monthsAhead);
const OWN = /monto propio/;

async function budgets(db: Db, person: Person, goal: string, months: string[], amount: number) {
  for (const month of months) {
    await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${goal}, ${month}::date, ${amount})`;
  }
}

// «Carrera en IA» holds «IA aplicada», which plans 12 h in each of three months ahead beyond the next one.
async function seedHolder(db: Db, person: Person, horizon: string | null) {
  const holder = await seedOpenGoal(db, person, { name: "Carrera en IA", horizon });
  const kid = await seedOpenGoal(db, person, { name: "IA aplicada", parent: holder, unit: MINUTES, horizon });
  await budgets(db, person, kid, AHEAD, 720);
  return holder;
}

const rowsOf = (page: Page) => page.locator("main ol:visible > li");

test("«Por mes» of a holder draws Dec–Feb (12 h each) in the first and only table, in order, with no «monto propio» anywhere", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: ignoring `goal.holdsGoals` when splitting hand-set months into a second table and its «estos meses con monto propio:».
  const holder = await seedHolder(db, person, null);
  const { page, context } = await visit(browser, baseURL, person, `/metas/${holder}/meses`, 360);
  try {
    await expect(page.getByRole("heading", { level: 1, name: "Por mes" })).toBeVisible();
    await expect(page.getByText(OWN)).toHaveCount(0);
    await expect(page.locator("main ol")).toHaveCount(1);
    await expect(page.locator("main table")).toHaveCount(1);

    const rows = rowsOf(page);
    const texts = (await rows.allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim().toLowerCase());
    const at = AHEAD.map((month) => texts.findIndex((text) => text.startsWith(label(month))));
    for (const index of at) expect(index, "each of the three months is a row of the one list").toBeGreaterThanOrEqual(0);
    expect(at[0]).toBeLessThan(at[1]);
    expect(at[1]).toBeLessThan(at[2]);
    for (const index of at) expect(texts[index]).toMatch(/(?<![\d.])12\s?h\b/);
    // They come after the next month, the one the list always names.
    expect(at[0]).toBeGreaterThan(texts.findIndex((text) => text.startsWith(label(monthsAhead(1)))));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("a holder with an end says «N de M meses» for exactly the rows its one table draws", async ({ person, browser, baseURL, db }) => {
  // Kills: the count taken from the first table's rows while the hand-set months sit in a second one (or the reverse).
  const holder = await seedHolder(db, person, monthsAhead(16));
  const { page, context } = await visit(browser, baseURL, person, `/metas/${holder}/meses`, 360);
  try {
    await expect(page.getByText(OWN)).toHaveCount(0);
    await expect(page.locator("main table")).toHaveCount(1);
    const caption = page.getByText(/^\d+ de \d+ meses$/).locator("visible=true");
    await expect(caption).toHaveCount(1);
    // The caption is set in capitals by CSS; `innerText` reads them back so.
    const said = (await caption.innerText()).match(/(\d+) de (\d+) meses/i);
    expect(said, "caption reads «N de M meses»").not.toBeNull();
    expect(Number(said![1])).toBe(await rowsOf(page).count());
    expect(Number(said![2])).toBeGreaterThan(Number(said![1]));
    for (const month of AHEAD) await expect(rowsOf(page).filter({ hasText: new RegExp(`^${label(month)}`, "i") })).toHaveCount(1);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("a goal with no goals inside keeps its second table and «estos meses con monto propio:»", async ({ person, browser, baseURL, db }) => {
  // Kills: the label taken out for every goal instead of for holders only.
  const solo = await seedOpenGoal(db, person, { name: "Escribir", unit: MINUTES, horizon: null });
  await budgets(db, person, solo, AHEAD, 720);
  const { page, context } = await visit(browser, baseURL, person, `/metas/${solo}/meses`, 360);
  try {
    await expect(page.getByText(/estos meses con monto propio:/).first()).toBeAttached();
    await expect(page.locator("main table")).toHaveCount(2);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});
