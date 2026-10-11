import type { Browser, Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// Module 815 (RP-28, RP-32, RP-35, RP-43, RP-73), board `MesesFuturoYTareas`: no screen of the months says a unit the
// catalogue translates («searches»); a unit other than time is said once, at the end («0 de 60 búsquedas»); a month
// that has not begun says «planeado» and its amount alone; «Por mes» of a time goal with no rhythm names each month's
// tasks, the label in two lines with no dangling «·».

const thisMonth = monthOf(todayInZone());
const lastMonth = monthOf(dayBefore(thisMonth));
const nextOne = nextMonth(thisMonth);
const horizon = nextMonth(nextMonth(nextOne));
const today = todayInZone();
const seg = (month: string) => month.slice(0, 7);

const NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const label = (month: string) => NAMES[Number(month.slice(5, 7)) - 1];

type Db = postgres.Sql;
type Unit = { measure: string; unit: string };
const SEARCHES: Unit = { measure: "búsquedas", unit: "searches" };
const KM: Unit = { measure: "km", unit: "km" };
const MINUTES: Unit = { measure: "minutos", unit: "minutos" };

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

async function seedGoal(
  db: Db,
  person: Person,
  options: {
    name: string;
    unit: Unit;
    budgets?: [string, number][];
    rhythm?: number;
    archived?: boolean;
    fact?: [string, number];
  },
): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at, archived_at)
    values (${person.id}, ${`${options.name} ${Date.now()}`}, ${horizon}::date, ${options.unit.measure}, ${options.unit.unit},
            ${options.rhythm ?? null}, (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC',
            ${options.archived ? db`now()` : null})
    returning id`;
  for (const [month, amount] of options.budgets ?? []) {
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${goal.id}, ${month}::date, ${amount})`;
  }
  if (options.fact) {
    const [commitment] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goal.id}, 'Ronda', 'daily', 'quantity', 5, ${options.unit.unit}, now() - interval '60 days')
      returning id`;
    await db`
      insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
      values (${person.id}, ${commitment.id}, ${goal.id}, ${options.fact[0]}::date, ${options.fact[1]})`;
  }
  return goal.id;
}

async function seedTask(db: Db, person: Person, goalId: string, name: string, month: string, estimate: number) {
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${goalId}, ${name}, ${month}::date, ${estimate})`;
}

async function visit(browser: Browser, baseURL: string | undefined, person: Person, path: string, width: number) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  return { page, close: () => context.close() };
}

async function drop(db: Db, person: Person, goalId: string) {
  await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
}

// A visible «Por mes» row, found by its month word; the 320px column at 1024 and the phone's stack alike.
const monthRow = (page: Page, month: string) =>
  page.locator("main ol li:visible", { hasText: new RegExp(`^${label(month)} ${month.slice(0, 4)}`, "i") }).first();

// The month page's amount block: from its label to the «Tareas» section after it.
async function amountBlock(page: Page, from: string): Promise<string> {
  await expect(page.locator("main").first()).toContainText(new RegExp(from, "i"));
  const main = flat(await page.locator("main").first().innerText()).toLowerCase();
  const start = main.indexOf(from);
  expect(start, `«${from}» on the page`).toBeGreaterThanOrEqual(0);
  const end = main.indexOf("tareas", start);
  return main.slice(start, end === -1 ? undefined : end).trim();
}

// The top of the first text run that matches `pattern` inside `row`, or -1.
async function lineTop(row: Locator, pattern: RegExp): Promise<number> {
  return row.evaluate((element, source) => {
    const regex = new RegExp(source);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const match = regex.exec(node.textContent ?? "");
      if (!match) continue;
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const rect = [...range.getClientRects()].find((box) => box.width > 0);
      if (rect) return Math.round(rect.top);
    }
    return -1;
  }, pattern.source);
}

// No row and no page is wider than its box.
async function noOverflow(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page scrollWidth").toBeLessThanOrEqual(width);
  // Every box inside the visible list ends within the list's own right edge (the 320px column at 1024).
  const wide = await page.evaluate(() => {
    const list = [...document.querySelectorAll<HTMLElement>("main ol")].find((node) => node.getClientRects().length > 0)!;
    const edge = list.getBoundingClientRect().right;
    return [...list.querySelectorAll<HTMLElement>("*")]
      .filter((node) => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().right > edge + 1)
      .map((node) => node.textContent);
  });
  expect(wide, "rows wider than their column").toEqual([]);
}

// ---- the unit, once, at the end ---------------------------------------------------------------------------------

for (const width of [360, 1024]) {
  test(`«Por mes» at ${width}, a searches goal: «0 de 60 búsquedas», the unit once, never «searches», no overflow`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const goalId = await seedGoal(db, person, { name: "Por mes búsquedas", unit: SEARCHES, budgets: [[thisMonth, 60]] });
    const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/meses`, width);
    try {
      const current = monthRow(page, thisMonth);
      await expect(current).toBeVisible();
      const text = flat(await current.innerText());
      expect(text).toContain("0 de 60 búsquedas");
      expect(text).not.toMatch(/searches/i);
      expect(text.match(/búsquedas/g)).toHaveLength(1);
      await noOverflow(page, width);
    } finally {
      await close();
      await drop(db, person, goalId);
    }
  });
}

test("«Por mes» at 360, a km goal: «20 de 40 km», the unit once at the end", async ({ person, browser, baseURL, db }) => {
  const goalId = await seedGoal(db, person, { name: "Por mes km", unit: KM, budgets: [[thisMonth, 40]], fact: [today, 20] });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/meses`, 360);
  try {
    const current = monthRow(page, thisMonth);
    await expect(current).toBeVisible();
    const text = flat(await current.innerText());
    expect(text).toContain("20 de 40 km");
    expect(text.match(/km/g)).toHaveLength(1);
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

test("the month page of a searches goal says «0 de 60 búsquedas» now and «planeado» with «80 búsquedas» ahead, never «searches»", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const goalId = await seedGoal(db, person, {
    name: "Mes búsquedas",
    unit: SEARCHES,
    budgets: [
      [thisMonth, 60],
      [nextOne, 80],
    ],
  });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/meses/${seg(thisMonth)}`, 360);
  try {
    await expect(page.locator("main").first()).toContainText("de 60 búsquedas");
    const now = flat(await page.locator("main").first().innerText());
    expect(now).toContain("0 de 60 búsquedas");
    expect(now).not.toContain("0 búsquedas de 60 búsquedas");
    expect(now).not.toMatch(/searches/i);

    await page.goto(`/metas/${goalId}/meses/${seg(nextOne)}`);
    const block = await amountBlock(page, "planeado");
    expect(block).toBe("planeado 80 búsquedas");
    expect(flat(await page.locator("main").first().innerText())).not.toMatch(/searches/i);
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

test("/mes says the unit once: «0 de 67 búsquedas», «15 de 40 km»; no amount keeps «0 min», never «searches»", async ({ person, browser, baseURL, db }) => {
  const searches = await seedGoal(db, person, { name: "Global búsquedas", unit: SEARCHES, budgets: [[thisMonth, 67]] });
  const km = await seedGoal(db, person, { name: "Correr", unit: KM, budgets: [[thisMonth, 40]], fact: [today, 15] });
  const minutes = await seedGoal(db, person, { name: "Portafolio", unit: MINUTES });
  await seedTask(db, person, minutes, "Pulir casos", thisMonth, 30);
  const bare = await seedGoal(db, person, { name: "Sin monto búsquedas", unit: SEARCHES });
  await seedTask(db, person, bare, "Revisar listas", thisMonth, 5);
  const { page, close } = await visit(browser, baseURL, person, "/mes", 360);
  try {
    const main = page.locator("main").first();
    // The figure and its «de <monto>» sit in two boxes: the page's own gap is the space between them.
    await expect(main).toContainText(/0\s*de\s*67\s*búsquedas/);
    await expect(main).toContainText(/15\s*de\s*40\s*km/);
    const text = flat(await main.innerText());
    expect(text).not.toMatch(/0 búsquedas de 67/);
    expect(text).not.toMatch(/15 km de 40/);
    expect(text).not.toMatch(/searches/i);
    const portfolio = flat(await page.locator("section", { hasText: "Portafolio" }).first().innerText());
    expect(portfolio).toContain("0 min");
    expect(portfolio).toContain("sin monto este mes");
    // A figure with no «de» keeps its unit.
    const unamounted = flat(await page.locator("section", { hasText: "Sin monto búsquedas" }).first().innerText());
    expect(unamounted).toContain("0 búsquedas");
  } finally {
    await close();
    for (const id of [searches, km, minutes, bare]) await drop(db, person, id);
  }
});

// ---- a month that has not begun ---------------------------------------------------------------------------------

test("a future month of a km goal with an amount: «planeado» and «60 km» alone, the amount a link to the sheet", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const goalId = await seedGoal(db, person, {
    name: "Futuro km",
    unit: KM,
    budgets: [
      [thisMonth, 40],
      [nextOne, 60],
    ],
  });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/meses/${seg(nextOne)}`, 360);
  try {
    expect(await amountBlock(page, "planeado")).toBe("planeado 60 km");
    const amount = page.getByRole("link", { name: "60 km", exact: true });
    await expect(amount).toHaveCount(1);
    await expect(amount).toHaveAttribute("href", new RegExp(`planear=${seg(nextOne)}`));
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

test("a future month of an archived goal: the amount is text, not a link", async ({ person, browser, baseURL, db }) => {
  const goalId = await seedGoal(db, person, {
    name: "Futuro archivada",
    unit: KM,
    archived: true,
    budgets: [
      [thisMonth, 40],
      [nextOne, 60],
    ],
  });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/meses/${seg(nextOne)}`, 360);
  try {
    expect(await amountBlock(page, "planeado")).toBe("planeado 60 km");
    await expect(page.getByRole("link", { name: "60 km", exact: true })).toHaveCount(0);
    await expect(page.getByText("60 km", { exact: true }).locator("visible=true").first()).toBeVisible();
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

test("a future month of a time goal with the goal's rhythm: «planeado» and «12 h» alone, a link, no «0 min»", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const goalId = await seedGoal(db, person, { name: "Futuro ritmo", unit: MINUTES, rhythm: 720 });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/meses/${seg(nextOne)}`, 360);
  try {
    expect(await amountBlock(page, "planeado")).toBe("planeado 12 h");
    await expect(page.getByRole("link", { name: "12 h", exact: true })).toHaveCount(1);
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

test("a future month with no amount says «sin monto planeado» alone", async ({ person, browser, baseURL, db }) => {
  const goalId = await seedGoal(db, person, { name: "Futuro sin monto", unit: KM, budgets: [[thisMonth, 40]] });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/meses/${seg(nextOne)}`, 360);
  try {
    await expect(page.locator("main").first()).toContainText("sin monto planeado");
    // Everything above the «Tareas» section: the title, then the phrase, and no figure or label of its own.
    const main = flat(await page.locator("main").first().innerText()).toLowerCase();
    const above = main.slice(0, main.indexOf("tareas", main.indexOf("sin monto planeado")));
    expect(above.trim().endsWith("sin monto planeado"), above).toBe(true);
    expect(above.match(/planeado/g)).toHaveLength(1);
    expect(above).not.toMatch(/0 km/);
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

test("the month in progress and the closed month say «20 de 40 km» and «0 de 10 km», the unit once", async ({ person, browser, baseURL, db }) => {
  const goalId = await seedGoal(db, person, {
    name: "Actual y pasado",
    unit: KM,
    budgets: [
      [lastMonth, 10],
      [thisMonth, 40],
    ],
    fact: [today, 20],
  });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/meses/${seg(thisMonth)}`, 360);
  try {
    expect(await amountBlock(page, "este mes")).toBe("este mes 20 de 40 km");
    await page.goto(`/metas/${goalId}/meses/${seg(lastMonth)}`);
    const closed = await amountBlock(page, "cerrado");
    expect(closed).toMatch(/^cerrado 0 de 10 km/);
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

test("the month in progress with no amount keeps its unit: «este mes 20 km» and «sin monto planeado»", async ({ person, browser, baseURL, db }) => {
  const goalId = await seedGoal(db, person, { name: "Actual sin monto", unit: KM, fact: [today, 20] });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/meses/${seg(thisMonth)}`, 360);
  try {
    const block = await amountBlock(page, "este mes");
    expect(block).toContain("20 km");
    expect(block).toContain("sin monto planeado");
    expect(block).not.toContain(" de ");
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

// ---- «Por mes» names a month's tasks (RP-73) --------------------------------------------------------------------

for (const width of [360, 1024]) {
  test(`«Por mes» at ${width}, a time goal with no rhythm: «en curso» over «2 tareas», no dangling «·», «sin monto» on the right, no overflow`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const goalId = await seedGoal(db, person, { name: "Tiempo sin ritmo", unit: MINUTES });
    await seedTask(db, person, goalId, "Uno", thisMonth, 60);
    await seedTask(db, person, goalId, "Dos", thisMonth, 30);
    await seedTask(db, person, goalId, "Tres", nextOne, 30);
    const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/meses`, width);
    try {
      const current = monthRow(page, thisMonth);
      await expect(current).toBeVisible();
      const state = await lineTop(current, /en curso/);
      const count = await lineTop(current, /2[\s ]tareas/);
      expect(state, "«en curso» drawn").toBeGreaterThanOrEqual(0);
      expect(count, "«2 tareas» drawn").toBeGreaterThan(state);
      await expect(current.locator("br"), "two lines, one break").toHaveCount(1);
      const text = flat(await current.innerText());
      expect(text).not.toContain("·");
      expect(text).toContain("sin monto");

      const later = monthRow(page, nextOne);
      expect(flat(await later.innerText())).toContain("1 tarea");
      expect(flat(await later.innerText())).not.toContain("·");
      await noOverflow(page, width);
    } finally {
      await close();
      await drop(db, person, goalId);
    }
  });
}

test("«Por mes» of a time goal with a rhythm does not count tasks: the plan counts them", async ({ person, browser, baseURL, db }) => {
  const goalId = await seedGoal(db, person, { name: "Tiempo con ritmo", unit: MINUTES, rhythm: 720 });
  await seedTask(db, person, goalId, "Uno", thisMonth, 60);
  await seedTask(db, person, goalId, "Dos", thisMonth, 30);
  const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/meses`, 360);
  try {
    const current = monthRow(page, thisMonth);
    await expect(current).toContainText("en curso");
    expect(flat(await current.innerText())).not.toContain("tarea");
    // One line under the label is no line break: a `<br>` with nothing after it draws an empty second line.
    await expect(current.locator("br")).toHaveCount(0);
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

for (const width of [360, 1024]) {
  test(`«Por mes» at ${width}, a km goal: «planeado» over «1 tarea» (no «·») and «en curso» over «2 tareas»; the future amount is bare`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const goalId = await seedGoal(db, person, {
      name: "Km tareas",
      unit: KM,
      budgets: [
        [thisMonth, 40],
        [nextOne, 30],
      ],
    });
    await seedTask(db, person, goalId, "Uno", thisMonth, 5);
    await seedTask(db, person, goalId, "Dos", thisMonth, 5);
    await seedTask(db, person, goalId, "Tres", nextOne, 5);
    const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/meses`, width);
    try {
      const future = monthRow(page, nextOne);
      await expect(future).toBeVisible();
      const planned = await lineTop(future, /planeado/);
      expect(planned, "«planeado» drawn").toBeGreaterThanOrEqual(0);
      expect(await lineTop(future, /1[\s ]tarea/), "«1 tarea» below «planeado»").toBeGreaterThan(planned);
      const text = flat(await future.innerText());
      expect(text).not.toContain("·");
      expect(text).toContain("30 km");
      expect(text).not.toContain("de 30");

      const current = monthRow(page, thisMonth);
      const state = await lineTop(current, /en curso/);
      expect(await lineTop(current, /2[\s ]tareas/)).toBeGreaterThan(state);
      expect(flat(await current.innerText())).not.toContain("·");
      await noOverflow(page, width);
    } finally {
      await close();
      await drop(db, person, goalId);
    }
  });
}
