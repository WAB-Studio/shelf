import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// Module 873 (RP-80), board `JerarquiaPorMes`: a goal that holds goals carries no rhythm and no month amounts of its
// own. «Por mes» reads each month as the sum of its goals' months, offers no «Planear», and a month page of it opens
// no amount sheet; «El plan» draws no rhythm form and lists the rhythm of its large goals instead. Its own tasks stay
// fixed to their month. Every row is seeded here with SQL; the holder carries a stored rhythm and stored month
// amounts that must never be read. Run under `PULSAR_CLOCK=2026-10-08` exported to the server and the spec alike.

const today = todayInZone();
const thisMonth = monthOf(today);
const oneAhead = nextMonth(thisMonth);
const twoAhead = nextMonth(oneAhead);
const threeAhead = nextMonth(twoAhead);
const horizon = nextMonth(nextMonth(threeAhead));
const seg = (month: string) => month.slice(0, 7);

const NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const label = (month: string) => NAMES[Number(month.slice(5, 7)) - 1];

type Db = postgres.Sql;
type Unit = { measure: string; unit: string };
const MINUTES: Unit = { measure: "minutos", unit: "minutos" };
const KM: Unit = { measure: "km", unit: "km" };

const HOLDER = "Product Designer junior";

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

async function seedGoal(
  db: Db,
  person: Person,
  options: {
    name: string;
    parent?: string | null;
    unit?: Unit | null;
    rhythm?: number;
    budgets?: [string, number][];
    fact?: number;
  },
): Promise<string> {
  const unit = options.unit ?? null;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, parent_id, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${person.id}, ${options.name}, ${options.parent ?? null}, ${horizon}::date, ${unit?.measure ?? null},
            ${unit?.unit ?? null}, ${options.rhythm ?? null}, (${thisMonth}::date - 20) + time '12:00' at time zone 'UTC')
    returning id`;
  for (const [month, amount] of options.budgets ?? []) {
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${goal.id}, ${month}::date, ${amount})`;
  }
  if (options.fact !== undefined && unit) {
    const [commitment] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goal.id}, 'Ronda', 'daily', 'quantity', 5, ${unit.unit}, now() - interval '60 days')
      returning id`;
    await db`
      insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
      values (${person.id}, ${commitment.id}, ${goal.id}, ${today}::date, ${options.fact})`;
  }
  return goal.id;
}

let position = 0;
async function seedTask(db: Db, person: Person, goalId: string, name: string, month: string, estimate: number, done = false) {
  position += 1;
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan, planned_month)
    values (${person.id}, ${goalId}, ${name}, ${estimate}, ${position}, true, ${month}::date)
    returning id`;
  if (done) {
    await db`
      insert into goals.facts (user_id, goal_id, one_off_id, day)
      values (${person.id}, ${goalId}, ${task.id}, ${today}::date)`;
  }
}

async function dropAll(db: Db, person: Person) {
  await db`delete from goals.goals where user_id = ${person.id}`;
}

// The holder of «Por mes» and the goals inside: a time goal of 120 and 60 minutes now, 200 and 100 a month ahead and
// 30 two ahead, and a goal in km that must add nothing. The holder's own stored amounts are decoys.
async function seedHolderWithMinutes(db: Db, person: Person) {
  const holder = await seedGoal(db, person, {
    name: HOLDER,
    unit: MINUTES,
    rhythm: 600,
    budgets: [
      [thisMonth, 999],
      [oneAhead, 777],
      [threeAhead, 888],
    ],
  });
  await seedGoal(db, person, {
    name: "Caso A",
    parent: holder,
    unit: MINUTES,
    budgets: [
      [thisMonth, 120],
      [oneAhead, 200],
    ],
    fact: 60,
  });
  await seedGoal(db, person, {
    name: "Caso B",
    parent: holder,
    unit: MINUTES,
    budgets: [
      [thisMonth, 60],
      [oneAhead, 100],
      [twoAhead, 30],
    ],
    fact: 30,
  });
  await seedGoal(db, person, {
    name: "Caso en km",
    parent: holder,
    unit: KM,
    budgets: [
      [thisMonth, 500],
      [oneAhead, 500],
    ],
    fact: 40,
  });
  return holder;
}

async function visit(browser: import("@playwright/test").Browser, baseURL: string | undefined, person: Person, path: string, width = 360) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator("main")).toBeVisible();
  return { page, close: () => context.close() };
}

// A visible «Por mes» row, found by its month word and year.
const monthRow = (page: Page, month: string) =>
  page.locator("main ol li:visible", { hasText: new RegExp(`^${label(month)} ${month.slice(0, 4)}`, "i") }).first();

const rowText = async (page: Page, month: string) => {
  const row = monthRow(page, month);
  await expect(row).toBeVisible();
  return flat(await row.innerText());
};

const mainText = async (page: Page) => flat(await page.locator("main").first().innerText());

// ---- «Por mes» --------------------------------------------------------------------------------------------------

test("«Por mes» of a holder reads each month as the sum of its goals' months, never its own stored amounts, and a goal in another unit adds nothing", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const holder = await seedHolderWithMinutes(db, person);
  const { page, close } = await visit(browser, baseURL, person, `/metas/${holder}/meses`);
  try {
    await expect(page.getByRole("heading", { level: 1, name: "Por mes" })).toBeVisible();

    // This month: 120 + 60 planned, 60 + 30 reached. 999 is the holder's stored amount, 500 km is another unit.
    const current = await rowText(page, thisMonth);
    expect(current).toContain("en curso");
    expect(current).toContain("1 h 30 min");
    expect(current).toContain("de 3 h");
    expect(current).not.toContain("16 h 39 min");
    expect(current).not.toContain("km");
    expect(current).not.toContain("11 h 20 min");
    expect(current).not.toContain("—");

    // A month ahead: 200 + 100, the amount alone and no figure reached.
    const next = await rowText(page, oneAhead);
    expect(next).toContain("planeado");
    expect(next).toContain("5 h");
    expect(next).toContain("—");
    expect(next).not.toContain("12 h 57 min");
    expect(next).not.toMatch(/de 5 h/);

    // Two ahead only the second goal covers it.
    const later = await rowText(page, twoAhead);
    expect(later).toContain("planeado");
    expect(later).toContain("30 min");

    for (const month of [thisMonth, oneAhead, twoAhead]) {
      await expect(monthRow(page, month).getByRole("link")).toHaveAttribute("href", `/metas/${holder}/meses/${seg(month)}`);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  } finally {
    await close();
    await dropAll(db, person);
  }
});

test("«Por mes» of a holder says it: «Cada mes suma el de sus metas.», with the way back to the holder", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const holder = await seedHolderWithMinutes(db, person);
  const { page, close } = await visit(browser, baseURL, person, `/metas/${holder}/meses`);
  try {
    await expect(page.getByRole("heading", { level: 1, name: "Por mes" })).toBeVisible();
    await expect(page.getByText("Cada mes suma el de sus metas.", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(HOLDER) }).first()).toHaveAttribute("href", `/metas/${holder}`);
  } finally {
    await close();
    await dropAll(db, person);
  }
});

test("«Por mes» of a holder that measures nothing itself still reads the sum of its goals in their unit", async ({ person, browser, baseURL, db }) => {
  const holder = await seedGoal(db, person, { name: HOLDER });
  await seedGoal(db, person, { name: "Caso A", parent: holder, unit: MINUTES, budgets: [[thisMonth, 120], [oneAhead, 200]], fact: 60 });
  await seedGoal(db, person, { name: "Caso B", parent: holder, unit: MINUTES, budgets: [[thisMonth, 60], [oneAhead, 100]], fact: 30 });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${holder}/meses`);
  try {
    await expect(page.getByRole("heading", { level: 1, name: "Por mes" })).toBeVisible();
    const current = await rowText(page, thisMonth);
    expect(current).toContain("1 h 30 min");
    expect(current).toContain("de 3 h");
    const next = await rowText(page, oneAhead);
    expect(next).toContain("5 h");
    const empty = await rowText(page, twoAhead);
    expect(empty).toContain("sin monto");
    expect(empty).not.toMatch(/\bde 0\b/);
  } finally {
    await close();
    await dropAll(db, person);
  }
});

test("«Por mes» of a holder says «sin monto» in a month no goal covers, even where the holder stored an amount, and never «0 de 0»", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const holder = await seedHolderWithMinutes(db, person);
  await seedTask(db, person, holder, "Entregar el informe", threeAhead, 45);
  const { page, close } = await visit(browser, baseURL, person, `/metas/${holder}/meses`);
  try {
    const empty = await rowText(page, threeAhead);
    expect(empty).toContain("sin monto");
    expect(empty).toContain("1 tarea");
    expect(empty).not.toContain("14 h 48 min");
    expect(empty).not.toMatch(/\b0 (min )?de 0\b/);
    expect(empty).not.toMatch(/\bde 0\b/);
    expect(empty).not.toContain("planeado");
  } finally {
    await close();
    await dropAll(db, person);
  }
});

test("«Por mes» of a holder counts its own tasks per month and adds what they reached to the sum", async ({ person, browser, baseURL, db }) => {
  const holder = await seedHolderWithMinutes(db, person);
  await seedTask(db, person, holder, "Revisar el plan con mi mentora", thisMonth, 60);
  await seedTask(db, person, holder, "Cerrar el informe", thisMonth, 15, true);
  await seedTask(db, person, holder, "Preparar la entrega", oneAhead, 90);
  const { page, close } = await visit(browser, baseURL, person, `/metas/${holder}/meses`);
  try {
    const current = await rowText(page, thisMonth);
    expect(current).toContain("2 tareas");
    // 60 + 30 from its goals, 15 from its own done task; the planned figure stays the goals' 3 h.
    expect(current).toContain("1 h 45 min");
    expect(current).toContain("de 3 h");
    const next = await rowText(page, oneAhead);
    expect(next).toContain("1 tarea");
    expect(next).not.toContain("1 tareas");
  } finally {
    await close();
    await dropAll(db, person);
  }
});

test("«Por mes» of a holder offers no «Planear» and no link to the amount sheet, and `?planear=` opens none", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const holder = await seedHolderWithMinutes(db, person);
  const { page, close } = await visit(browser, baseURL, person, `/metas/${holder}/meses`);
  try {
    await expect(page.getByRole("heading", { level: 1, name: "Por mes" })).toBeVisible();
    expect(await mainText(page)).not.toMatch(/planear/i);
    await expect(page.locator("main a[href*=planear]")).toHaveCount(0);

    for (const month of [thisMonth, oneAhead, threeAhead]) {
      await page.goto(`/metas/${holder}/meses?planear=${seg(month)}`);
      await expect(page.getByRole("heading", { level: 1, name: "Por mes" })).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(await mainText(page)).not.toMatch(/¿cuánto en/i);
    }
  } finally {
    await close();
    await dropAll(db, person);
  }
});

test("a month page of a holder offers no amount sheet and keeps its own task in its month", async ({ person, browser, baseURL, db }) => {
  const holder = await seedHolderWithMinutes(db, person);
  await seedTask(db, person, holder, "Entregar el informe", threeAhead, 45);
  const { page, close } = await visit(browser, baseURL, person, `/metas/${holder}/meses/${seg(threeAhead)}`);
  try {
    await expect(page.getByText("Entregar el informe", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "sin monto planeado" })).toHaveCount(0);
    await expect(page.locator("a[href*=planear]")).toHaveCount(0);
    expect(await mainText(page)).not.toMatch(/planear/i);

    await page.goto(`/metas/${holder}/meses/${seg(thisMonth)}`);
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator("a[href*=planear]")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await mainText(page)).not.toMatch(/planear/i);

    // The sheet's own address, typed by hand, opens nothing either.
    await page.goto(`/metas/${holder}/meses/${seg(oneAhead)}?planear=${seg(oneAhead)}`);
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await close();
    await dropAll(db, person);
  }
});

test("«Por mes» of a holder whose goals measure nothing this month says «sin monto» in it, never «0 de 0» (the holder's own amount stays unread)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const holder = await seedGoal(db, person, { name: HOLDER, unit: MINUTES, budgets: [[thisMonth, 500]] });
  await seedGoal(db, person, { name: "Caso A", parent: holder, unit: MINUTES, budgets: [[oneAhead, 120]] });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${holder}/meses`);
  try {
    const current = await rowText(page, thisMonth);
    expect(current).toContain("en curso");
    expect(current).toContain("sin monto");
    expect(current).not.toMatch(/\bde 0\b/);
    expect(current).not.toContain("8 h 20 min");
    const next = await rowText(page, oneAhead);
    expect(next).toContain("2 h");
  } finally {
    await close();
    await dropAll(db, person);
  }
});

test("«Por mes» of a holder whose goals have no amount anywhere says «sin monto» in every month and invites no planning", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const holder = await seedGoal(db, person, { name: HOLDER });
  await seedGoal(db, person, { name: "Caso A", parent: holder, unit: MINUTES });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${holder}/meses`);
  try {
    await expect(page.getByRole("heading", { level: 1, name: "Por mes" })).toBeVisible();
    const current = await rowText(page, thisMonth);
    expect(current).toContain("sin monto");
    expect(current).not.toMatch(/\bde 0\b/);
    const text = await mainText(page);
    expect(text).not.toMatch(/planear/i);
    expect(text).not.toContain("Ponle uno");
    expect(text).not.toContain("Ningún mes tiene monto");
    await expect(page.locator("main a[href*=planear]")).toHaveCount(0);
  } finally {
    await close();
    await dropAll(db, person);
  }
});

test("a month sums three levels: the holder reads its large goal's sum of small goals, not the large goal's stored amount", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const holder = await seedGoal(db, person, { name: HOLDER, unit: MINUTES });
  const large = await seedGoal(db, person, { name: "Caso grande", parent: holder, unit: MINUTES, budgets: [[thisMonth, 777]] });
  await seedGoal(db, person, { name: "Pequeña 1", parent: large, unit: MINUTES, budgets: [[thisMonth, 100]] });
  await seedGoal(db, person, { name: "Pequeña 2", parent: large, unit: MINUTES, budgets: [[thisMonth, 80]] });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${holder}/meses`);
  try {
    const current = await rowText(page, thisMonth);
    expect(current).toContain("de 3 h");
    expect(current).not.toContain("12 h 57 min");
    expect(current).not.toContain("15 h 57 min");
  } finally {
    await close();
    await dropAll(db, person);
  }
});

// ---- «El plan» --------------------------------------------------------------------------------------------------

// A holder with a stored rhythm, a large goal that holds two small ones (27 h now), a large goal that begins in two
// months (30 h), and two tasks of its own in two months.
async function seedPlan(db: Db, person: Person) {
  const holder = await seedGoal(db, person, { name: HOLDER, unit: MINUTES, rhythm: 600 });
  const first = await seedGoal(db, person, {
    name: "Caso #1 · Urban Vibes",
    parent: holder,
    unit: MINUTES,
    budgets: [[thisMonth, 100]],
  });
  await seedGoal(db, person, { name: "Búsqueda de referencias", parent: first, unit: MINUTES, budgets: [[thisMonth, 1000]] });
  await seedGoal(db, person, { name: "Prototipo navegable", parent: first, unit: MINUTES, budgets: [[thisMonth, 620]] });
  await seedGoal(db, person, { name: "Caso #2 · Nutria con IA", parent: holder, unit: MINUTES, budgets: [[twoAhead, 1800]] });
  await seedTask(db, person, holder, "Revisar el plan con mi mentora", thisMonth, 60);
  await seedTask(db, person, holder, "Preparar la entrega", oneAhead, 90);
  return { holder, first };
}

test("`/plan` of a holder draws the board sentence and no rhythm control, chips or «Armar el plan»", async ({ person, browser, baseURL, db }) => {
  const { holder } = await seedPlan(db, person);
  const { page, close } = await visit(browser, baseURL, person, `/metas/${holder}/plan`);
  try {
    await expect(page.getByRole("heading", { level: 1, name: "El plan" })).toBeVisible();
    await expect(page.getByText("Este plan no tiene ritmo propio. Cada mes suma el de sus metas.", { exact: true })).toBeVisible();
    await expect(page.getByText("Horas al mes", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByPlaceholder("otra")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Armar el plan" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Ritmo .* al mes/ })).toHaveCount(0);
    const text = await mainText(page);
    expect(text).not.toContain("Cambiar");
    expect(text).not.toContain("Dile al plan");
    // 600 min a month is the stored rhythm: it is not read.
    expect(text).not.toContain("10 h al mes");
  } finally {
    await close();
    await dropAll(db, person);
  }
});

test("`/plan` of a holder lists the rhythm of its large goals, one row each, small goals left out", async ({ person, browser, baseURL, db }) => {
  const { holder, first } = await seedPlan(db, person);
  const { page, close } = await visit(browser, baseURL, person, `/metas/${holder}/plan`);
  try {
    const text = (await mainText(page)).toLowerCase();
    expect(text).toContain("el ritmo de sus metas");

    const one = page.getByRole("link").filter({ hasText: "Caso #1 · Urban Vibes" });
    await expect(one).toHaveCount(1);
    await expect(one).toContainText(`27 h en ${label(thisMonth)}`);
    await expect(one).toHaveAttribute("href", new RegExp(`^/metas/${first}`));

    const two = page.getByRole("link").filter({ hasText: "Caso #2 · Nutria con IA" });
    await expect(two).toHaveCount(1);
    expect(flat(await two.innerText())).toContain(`empieza en ${label(twoAhead)} · 30 h`);

    expect(text).not.toContain("búsqueda de referencias");
    expect(text).not.toContain("prototipo navegable");
    await expect(page.getByRole("link").filter({ hasText: /Caso #/ })).toHaveCount(2);
  } finally {
    await close();
    await dropAll(db, person);
  }
});

test("`/plan` of a holder lists its own tasks under a section per month, with «Añadir una tarea» and «Ver mes por mes»", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const { holder } = await seedPlan(db, person);
  const { page, close } = await visit(browser, baseURL, person, `/metas/${holder}/plan`);
  try {
    const text = (await mainText(page)).toLowerCase();
    const now = `sus tareas · ${label(thisMonth)} ${thisMonth.slice(0, 4)}`;
    const later = `sus tareas · ${label(oneAhead)} ${oneAhead.slice(0, 4)}`;
    const a = text.indexOf(now);
    const b = text.indexOf(later);
    expect(a, `«${now}» on the page`).toBeGreaterThanOrEqual(0);
    expect(b, `«${later}» on the page`).toBeGreaterThan(a);
    const first = text.slice(a, b);
    expect(first).toContain("revisar el plan con mi mentora");
    expect(first).toMatch(/\b1 h\b/);
    expect(first).not.toContain("preparar la entrega");
    expect(text.slice(b)).toContain("preparar la entrega");
    expect(text.slice(b)).toContain("1 h 30 min");

    await expect(page.getByText("Añadir una tarea", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Ver mes por mes" })).toHaveAttribute("href", `/metas/${holder}/meses`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  } finally {
    await close();
    await dropAll(db, person);
  }
});
