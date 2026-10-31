import type { Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

import { test, expect, visit } from "./fixtures";

// `JerarquiaArbol` (RP-81, RP-80, RNP-07, RNP-17): `/metas` draws the tree.
// The «ABIERTAS» group is hairline rows in the tree's order; a holder carries
// a fold arrow in a 20 px slot, its month is the sum of the goals under it in
// its own unit, and its line says «hasta el … · N metas» (N = goals directly
// inside it). Folding is screen-only: no request, nothing stored.
const MONTH_LONG = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const today = todayInZone();
const month = `${today.slice(0, 7)}-01`;
const monthName = MONTH_LONG[Number(today.slice(5, 7)) - 1];

function inDays(days: number): string {
  const date = civilDateToDate(today);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

async function seedGoal(
  db: postgres.Sql,
  personId: string,
  name: string,
  unit: string | null,
  horizonDays: number,
  parentId: string | null = null,
): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, parent_id, created_at)
    values (${personId}, ${name}, ${inDays(horizonDays)}::date, ${unit}, ${unit}, ${parentId}, ${new Date(Date.now() - 20 * 86_400_000)})
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

async function seedMinutes(db: postgres.Sql, personId: string, goalId: string, minutes: number) {
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${personId}, ${goalId}, ${`Bloque ${goalId}`}, 'daily', 'quantity', 10, 'min', now() - interval '40 days')
    returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${personId}, ${goalId}, ${commitment.id}, ${today}::date, ${minutes})
  `;
}

async function seedKm(db: postgres.Sql, personId: string, goalId: string, quantity: number) {
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${personId}, ${goalId}, ${`Hecho ${goalId}`}, 'daily', 'quantity', 10, 'km', now() - interval '40 days')
    returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${personId}, ${goalId}, ${commitment.id}, ${today}::date, ${quantity})
  `;
}

type Tree = { general: string; big: string; small: string; big2: string; alone: string; ids: Record<string, string> };

// G (min) > g1 (min) > p (min), G > g2; a lone goal at the foot. G keeps a
// stored month of its own, which a holder must never read (RP-80).
async function seedTree(db: postgres.Sql, personId: string, g2Unit: "min" | "km" = "min"): Promise<Tree> {
  const stamp = Date.now();
  const names = {
    general: `General ${stamp}`,
    big: `Alfa ${stamp}`,
    small: `Pico con un nombre bastante largo para una fila de teléfono ${stamp}`,
    big2: `Zeta ${stamp}`,
    alone: `Suelta ${stamp}`,
  };
  const general = await seedGoal(db, personId, names.general, "min", 400);
  await seedBudget(db, personId, general, 999);
  const big = await seedGoal(db, personId, names.big, "min", 300, general);
  const small = await seedGoal(db, personId, names.small, "min", 200, big);
  await seedBudget(db, personId, small, 120);
  await seedMinutes(db, personId, small, 60);
  const big2 = await seedGoal(db, personId, names.big2, g2Unit, 300, general);
  if (g2Unit === "min") {
    await seedBudget(db, personId, big2, 60);
    await seedMinutes(db, personId, big2, 30);
  } else {
    await seedBudget(db, personId, big2, 40);
    await seedKm(db, personId, big2, 15);
  }
  const alone = await seedGoal(db, personId, names.alone, null, 100);
  return { ...names, ids: { general, big, small, big2, alone } };
}

const norm = (text: string) => text.replace(/\s+/g, " ").trim();

function row(page: Page, name: string): Locator {
  return page.locator("main").locator("a", { hasText: name });
}

// A goal's own arrow, by the goal's name («Plegar <name>» / «Desplegar <name>»).
function arrowOf(page: Page, name: string): Locator {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.locator("main").getByRole("button", { name: new RegExp(`^(Plegar|Desplegar) ${escaped}$`) });
}

function folds(page: Page): Locator {
  return page.locator("main").getByRole("button", { name: /^(Plegar|Desplegar)/ });
}

// Left edge of the goal's name text, not of the row's box.
async function nameLeft(page: Page, name: string): Promise<number> {
  return row(page, name).evaluate((el, label) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && node.textContent?.trim() !== label) node = walker.nextNode();
    if (!node) throw new Error(`no name text «${label}»`);
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().left;
  }, name);
}

async function top(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no box");
  return box.y;
}

async function open(browser: import("@playwright/test").Browser, sessionFile: string, width: number) {
  const context = await browser.newContext({
    storageState: sessionFile,
    viewport: { width, height: 1200 },
    hasTouch: width < 600,
  });
  const page = await context.newPage();
  await visit(page, "/metas");
  return { context, page };
}

test("/metas draws the tree in order: G, its large goal indented, the small under it deeper, the next large goal level with the first, the lone goal flush at the foot", async ({
  person,
  browser,
  db,
}) => {
  // Kills: drawing `open` flat (every left edge equal, no arrow).
  const tree = await seedTree(db, person.id);
  const { context, page } = await open(browser, person.sessionFile, 360);
  try {
    const rows = [tree.general, tree.big, tree.small, tree.big2, tree.alone];
    for (const name of rows) await expect(row(page, name)).toBeVisible();
    const tops = [];
    for (const name of rows) tops.push(await top(row(page, name)));
    expect(tops).toEqual([...tops].sort((a, b) => a - b));

    const left = {
      general: await nameLeft(page, tree.general),
      big: await nameLeft(page, tree.big),
      small: await nameLeft(page, tree.small),
      big2: await nameLeft(page, tree.big2),
      alone: await nameLeft(page, tree.alone),
    };
    // 360: general 52, large 72, small 92; the lone goal has no indent.
    expect(left.big).toBeCloseTo(left.big2, 0);
    expect(left.big - left.general).toBeCloseTo(20, 0);
    expect(left.small - left.big).toBeCloseTo(20, 0);
    expect(left.general).toBeCloseTo(52, 0);
    expect(left.alone).toBeLessThan(left.general);
    // One arrow per holder: G and the first large goal, never a leaf.
    await expect(folds(page)).toHaveCount(2);
  } finally {
    await context.close();
  }
});

test("a holder's month is the sum of the goals under it: «1 h 30 min de 3 h», never its own stored month", async ({
  person,
  browser,
  db,
}) => {
  // Kills: showing G's own month (its stored 999 min) instead of the sum.
  const tree = await seedTree(db, person.id);
  const { context, page } = await open(browser, person.sessionFile, 360);
  try {
    const general = norm(await row(page, tree.general).innerText());
    expect(general).toContain(`${monthName} · 1 h 30 min de 3 h`);
    expect(general).not.toContain("16 h 39");
    // The large goal holding one small goal reads that goal's figure.
    expect(norm(await row(page, tree.big).innerText())).toContain(`${monthName} · 1 h de 2 h`);
  } finally {
    await context.close();
  }
});

test("a goal in another unit adds nothing to its holder's figure and /metas draws no other-unit line", async ({
  person,
  browser,
  db,
}) => {
  // Kills: summing the month ignoring the unit (G would read 15 + 60 + ... of mixed units).
  const tree = await seedTree(db, person.id, "km");
  const { context, page } = await open(browser, person.sessionFile, 360);
  try {
    const general = norm(await row(page, tree.general).innerText());
    expect(general).toContain(`${monthName} · 1 h de 2 h`);
    expect(general).not.toMatch(/km/);
    expect(norm(await row(page, tree.big2).innerText())).toContain(`${monthName} · 15 de 40 km`);
    await expect(page.locator("main").getByText(/no suma aquí/)).toHaveCount(0);
    await expect(page.locator("main").getByText(/mide en/)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a holder's row reads «· N metas» with the goals directly inside it", async ({ person, browser, db }) => {
  // Kills: omitting the count (or counting it on leaves).
  const tree = await seedTree(db, person.id);
  const { context, page } = await open(browser, person.sessionFile, 360);
  try {
    expect(norm(await row(page, tree.general).innerText())).toMatch(/hasta el .+ · 2 metas$/m);
    expect(norm(await row(page, tree.big).innerText())).toMatch(/hasta el .+ · 1 meta$/m);
    for (const leaf of [tree.small, tree.big2, tree.alone]) {
      expect(norm(await row(page, leaf).innerText())).not.toMatch(/ metas?\b/);
    }
  } finally {
    await context.close();
  }
});

test("folding G's arrow hides every goal under it, unfolding shows them; no request leaves, nothing is stored, the name still opens the goal", async ({
  person,
  browser,
  db,
}) => {
  // Kills: folding only the first row under G (the small goal and the second large goal stay).
  const tree = await seedTree(db, person.id);
  const { context, page } = await open(browser, person.sessionFile, 360);
  try {
    const sent: string[] = [];
    let navigated = 0;
    page.on("request", (request) => {
      if (request.method() !== "GET") sent.push(`${request.method()} ${request.url()}`);
    });
    page.on("framenavigated", () => {
      navigated += 1;
    });
    const url = page.url();

    await expect(folds(page)).toHaveCount(2);
    await folds(page).first().click();
    for (const name of [tree.big, tree.small, tree.big2]) await expect(row(page, name)).toHaveCount(0);
    await expect(row(page, tree.general)).toBeVisible();
    await expect(row(page, tree.alone)).toBeVisible();
    // The count stays on the folded row.
    expect(norm(await row(page, tree.general).innerText())).toContain("2 metas");
    await expect(folds(page)).toHaveCount(1);
    await expect(folds(page).first()).toHaveAccessibleName(/^Desplegar/);

    await folds(page).first().click();
    for (const name of [tree.big, tree.small, tree.big2]) await expect(row(page, name)).toBeVisible();
    await expect(folds(page)).toHaveCount(2);

    expect(sent).toEqual([]);
    expect(navigated).toBe(0);
    expect(page.url()).toBe(url);

    // Screen-only: a reload draws everything open again.
    await folds(page).first().click();
    await expect(row(page, tree.big)).toHaveCount(0);
    await page.reload();
    await expect(row(page, tree.big)).toBeVisible();

    // Tapping the name opens the goal.
    await row(page, tree.general).click();
    await expect(page).toHaveURL(new RegExp(`/metas/${tree.ids.general}$`));
  } finally {
    await context.close();
  }
});

test("folding one large goal hides only its small goals; the count on its row stays", async ({ person, browser, db }) => {
  // Kills: a fold that hides siblings or does not hide the branch's own children.
  const tree = await seedTree(db, person.id);
  const { context, page } = await open(browser, person.sessionFile, 360);
  try {
    await expect(folds(page)).toHaveCount(2);
    await folds(page).nth(1).click();
    await expect(row(page, tree.small)).toHaveCount(0);
    await expect(row(page, tree.big)).toBeVisible();
    await expect(row(page, tree.big2)).toBeVisible();
    expect(norm(await row(page, tree.big).innerText())).toContain("1 meta");
  } finally {
    await context.close();
  }
});

test("three lone goals draw as three cards, with no arrow and no count of goals inside", async ({ person, browser, db }) => {
  // Kills: giving a leaf an arrow, or a card that says «N metas» for a goal holding none.
  const stamp = Date.now();
  const names = [`Uno ${stamp}`, `Dos ${stamp}`, `Tres ${stamp}`];
  for (const [i, name] of names.entries()) await seedGoal(db, person.id, name, null, 60 + i * 10);
  const { context, page } = await open(browser, person.sessionFile, 360);
  try {
    // On the phone a card is no box of its own, so its edge is its name's.
    const left = (name: string) => page.locator("main").getByText(name, { exact: true }).first().evaluate((el) => el.getBoundingClientRect().left);
    const lefts = [];
    for (const name of names) lefts.push(await left(name));
    // One column at 360: every card on the same left edge, the page's own gutter.
    expect(lefts[1]).toBeCloseTo(lefts[0], 0);
    expect(lefts[2]).toBeCloseTo(lefts[0], 0);
    expect(lefts[0]).toBeCloseTo(20, 0);
    await expect(folds(page)).toHaveCount(0);
    for (const name of names) {
      expect(norm(await page.locator("main").getByRole("region", { name }).innerText())).not.toMatch(/ metas?\b/);
    }
  } finally {
    await context.close();
  }
});

test("at 360 with three levels nothing overflows sideways and the fold arrows and rows are at least 32 px", async ({
  person,
  browser,
  db,
}) => {
  // Kills: a fixed px indent that overflows; an arrow drawn at its 20 px glyph box.
  const tree = await seedTree(db, person.id);
  const { context, page } = await open(browser, person.sessionFile, 360);
  try {
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    const arrows = folds(page);
    await expect(arrows).toHaveCount(2);
    for (let i = 0; i < 2; i += 1) {
      const box = await arrows.nth(i).boundingBox();
      expect(box!.width, `arrow ${i} width`).toBeGreaterThanOrEqual(32);
      expect(box!.height, `arrow ${i} height`).toBeGreaterThanOrEqual(32);
    }
    for (const name of [tree.general, tree.big, tree.small, tree.big2, tree.alone]) {
      const box = await row(page, name).boundingBox();
      expect(box!.height, `${name} row`).toBeGreaterThanOrEqual(32);
      expect(box!.x + box!.width, `${name} right edge`).toBeLessThanOrEqual(360);
    }
  } finally {
    await context.close();
  }
});

test("each fold arrow's name carries its own goal's name, so two arrows never share a label", async ({
  person,
  browser,
  db,
}) => {
  // Kills: one fixed label («Plegar») on every arrow.
  const tree = await seedTree(db, person.id);
  const { context, page } = await open(browser, person.sessionFile, 360);
  try {
    await expect(folds(page)).toHaveCount(2);
    await expect(arrowOf(page, tree.general)).toHaveAccessibleName(`Plegar ${tree.general}`);
    await expect(arrowOf(page, tree.big)).toHaveAccessibleName(`Plegar ${tree.big}`);
    const names = await folds(page).evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? el.textContent));
    expect(new Set(names).size).toBe(names.length);
    await arrowOf(page, tree.general).click();
    await expect(arrowOf(page, tree.general)).toHaveAccessibleName(`Desplegar ${tree.general}`);
  } finally {
    await context.close();
  }
});
