import type { Browser, Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// `RielArbol` (approved 2026-10-13): from 1280 the rail's «METAS ABIERTAS» draws the tree — a general with its goals indented
// under it, in the tree's order, folding as `/metas` does; a goal with no goals inside has no fold control. Below 1024 the
// bottom nav is untouched.
const horizon = (() => {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + 120);
  return dateToCivilDate(date);
})();

type Names = { general: string; big: string; small: string; second: string; loose: string };

// G (position 10) > g1 (30) > p (40), G > g2 (50), and a loose L (20). Flat by position: G, L, g1, p, g2; the tree: G, g1, p, g2, L.
async function seed(db: postgres.Sql, person: Person): Promise<Names> {
  const stamp = Date.now();
  const n: Names = {
    general: `Riel general ${stamp}`,
    big: `Riel grande ${stamp}`,
    small: `Riel pequeña ${stamp}`,
    second: `Riel segunda ${stamp}`,
    loose: `Riel suelta ${stamp}`,
  };
  const goal = async (name: string, position: number, parent: string | null) => {
    const [row] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, parent_id, position, created_at)
      values (${person.id}, ${name}, ${horizon}::date, ${parent}, ${position}, now() - interval '5 days')
      returning id
    `;
    return row.id;
  };
  const general = await goal(n.general, 10, null);
  await goal(n.loose, 20, null);
  const big = await goal(n.big, 30, general);
  await goal(n.small, 40, big);
  await goal(n.second, 50, general);
  return n;
}

const clear = (db: postgres.Sql, person: Person) => db`delete from goals.goals where user_id = ${person.id}`;

async function open(browser: Browser, baseURL: string, person: Person, width: number, path: string) {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL,
    viewport: { width, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(path);
  await expect(page.getByRole("main")).toContainText(/\S/);
  return { context, page };
}

const link = (page: Page, name: string): Locator => page.getByRole("navigation").getByRole("link", { name, exact: true });
const fold = (page: Page, name: string): Locator =>
  page.getByRole("navigation").getByRole("button", { name: new RegExp(`^(Plegar|Desplegar) ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
const folds = (page: Page): Locator => page.getByRole("navigation").getByRole("button", { name: /^(Plegar|Desplegar) / });

// Where a link's text starts: the indent the tree gives it, whatever wrapper carries it.
const textLeft = (locator: Locator) =>
  locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().left;
  });

test("at 1280 the rail lists the goals as the tree, a general's goals right after it, not as the flat list", async ({
  person, browser, baseURL, db,
}) => {
  const n = await seed(db, person);
  const { context, page } = await open(browser, baseURL!, person, 1280, "/semana");
  try {
    const nav = page.getByRole("navigation");
    await expect(nav).toContainText(/metas abiertas/i);
    await expect(link(page, n.general)).toBeVisible();
    const names = (await nav.getByRole("link").allInnerTexts()).map((t) => t.trim());
    expect(names.slice(0, 4), "the four tabs first, unchanged").toEqual(["Hoy", "Semana", "Mes", "Metas"]);
    expect(names.slice(4)).toEqual([n.general, n.big, n.small, n.second, n.loose]);
    await expect(nav.getByRole("link").filter({ hasText: /^(Hoy|Semana|Mes|Metas)$/ })).toHaveCount(4);
  } finally {
    await context.close();
    await clear(db, person);
  }
});

test("at 1280 each level sits further in than the one above, siblings and roots align", async ({ person, browser, baseURL, db }) => {
  const n = await seed(db, person);
  const { context, page } = await open(browser, baseURL!, person, 1280, "/semana");
  try {
    await expect(link(page, n.general)).toBeVisible();
    const [g, big, small, second, loose] = await Promise.all(
      [n.general, n.big, n.small, n.second, n.loose].map((name) => textLeft(link(page, name))),
    );
    expect(big - g, "a large goal is indented under its general").toBeGreaterThanOrEqual(12);
    expect(small - big, "a small goal is indented under its large goal").toBeGreaterThanOrEqual(12);
    expect(Math.abs(second - big), "siblings align").toBeLessThanOrEqual(1);
    expect(Math.abs(loose - g), "a goal with no goals inside aligns with a general").toBeLessThanOrEqual(1);
  } finally {
    await context.close();
    await clear(db, person);
  }
});

test("at 1280 only a goal with goals inside has a fold control; folding hides what is under it, only there, and /metas keeps its own tree", async ({
  person, browser, baseURL, db,
}) => {
  const n = await seed(db, person);
  const { context, page } = await open(browser, baseURL!, person, 1280, "/metas");
  try {
    await expect(link(page, n.general)).toBeVisible();
    await expect(folds(page), "G and g1 fold; p, g2 and L have nothing under them").toHaveCount(2);
    await expect(fold(page, n.general)).toHaveAccessibleName(`Plegar ${n.general}`);
    await expect(fold(page, n.big)).toBeVisible();
    for (const leaf of [n.small, n.second, n.loose]) await expect(fold(page, leaf)).toHaveCount(0);

    // A large goal folds its own goals and nothing else.
    await fold(page, n.big).click();
    await expect(link(page, n.small)).toBeHidden();
    for (const shown of [n.general, n.big, n.second, n.loose]) await expect(link(page, shown)).toBeVisible();
    await expect(fold(page, n.big)).toHaveAccessibleName(`Desplegar ${n.big}`);

    // A general folds every goal under it, the already folded one too; the loose goal stays.
    await fold(page, n.general).click();
    for (const hidden of [n.big, n.small, n.second]) await expect(link(page, hidden)).toBeHidden();
    for (const shown of [n.general, n.loose]) await expect(link(page, shown)).toBeVisible();
    await expect(folds(page)).toHaveCount(1);
    await expect(fold(page, n.general)).toHaveAccessibleName(`Desplegar ${n.general}`);

    // `/metas`'s own tree is untouched: the rail folds on its own.
    await expect(page.getByRole("main").getByText(n.small, { exact: true })).toBeVisible();

    await fold(page, n.general).click();
    for (const shown of [n.big, n.second]) await expect(link(page, shown)).toBeVisible();
    await expect(link(page, n.small), "g1 was folded before and stays folded").toBeHidden();
    await fold(page, n.big).click();
    await expect(link(page, n.small)).toBeVisible();
    await expect(folds(page)).toHaveCount(2);
  } finally {
    await context.close();
    await clear(db, person);
  }
});

test("a fold control is not a link: tapping it opens no goal", async ({ person, browser, baseURL, db }) => {
  const n = await seed(db, person);
  const { context, page } = await open(browser, baseURL!, person, 1280, "/semana");
  try {
    await expect(link(page, n.general)).toBeVisible();
    await fold(page, n.general).click();
    await expect(page).toHaveURL((url) => url.pathname === "/semana");
    await expect(link(page, n.second)).toBeHidden();
  } finally {
    await context.close();
    await clear(db, person);
  }
});

test("at 360 the bottom nav is untouched: four tabs, no goal and no fold control", async ({ person, browser, baseURL, db }) => {
  const n = await seed(db, person);
  const { context, page } = await open(browser, baseURL!, person, 360, "/semana");
  try {
    const nav = page.getByRole("navigation");
    await expect(nav.getByRole("link").filter({ hasText: /^(Hoy|Semana|Mes|Metas)$/ })).toHaveCount(4);
    for (const name of [n.general, n.big, n.small, n.second, n.loose]) await expect(link(page, name)).toBeHidden();
    await expect(folds(page)).toHaveCount(0);
    await expect(nav.getByRole("button")).toBeHidden();
  } finally {
    await context.close();
    await clear(db, person);
  }
});
