import { test, expect } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// RP-69 (RP-65): «Por mes» of a goal measured in km says how many tasks each
// month's list holds, and that goal's empty month never promises time.

const NAMES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];
const label = (month: string) => NAMES[Number(month.slice(5, 7)) - 1];
const seg = (month: string) => month.slice(0, 7);

const thisMonth = monthOf(todayInZone());
const lastMonth = monthOf(dayBefore(thisMonth));
const followingMonth = nextMonth(thisMonth);
const horizon = nextMonth(followingMonth);

type Db = import("postgres").Sql;

async function seedGoal(db: Db, personId: string, name: string, measure: "km" | "minutos") {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${name}, ${horizon}::date, ${measure}, ${measure}, (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
    returning id
  `;
  return goal.id;
}

async function seedTask(db: Db, personId: string, goalId: string, name: string, month: string, estimate: number | null) {
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${personId}, ${goalId}, ${name}, ${month}::date, ${estimate})
  `;
}

async function seedBudget(db: Db, personId: string, goalId: string, month: string, amount: number) {
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${personId}, ${goalId}, ${month}::date, ${amount})
  `;
}

async function rows(
  page: import("@playwright/test").Page,
  goalId: string,
  width: number,
): Promise<(month: string) => import("@playwright/test").Locator> {
  await page.setViewportSize({ width, height: width >= 1024 ? 900 : 740 });
  await page.goto(`/metas/${goalId}/meses`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  return (month) => page.locator("main ol li:visible", { hasText: new RegExp(`^${label(month)}`, "i") }).first();
}

async function open(browser: import("@playwright/test").Browser, baseURL: string | undefined, sessionFile: string) {
  return browser.newContext({ storageState: sessionFile, baseURL: baseURL! });
}

for (const width of [360, 1440]) {
  test(`km goal, this month with two tasks: the row names «en curso» and «2 tareas», no dangling «·», at ${width} (RP-73)`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const goalId = await seedGoal(db, person.id, `Meta km en curso ${stamp}`, "km");
    await seedBudget(db, person.id, goalId, thisMonth, 40);
    await seedTask(db, person.id, goalId, `Uno ${stamp}`, thisMonth, 5);
    await seedTask(db, person.id, goalId, `Dos ${stamp}`, thisMonth, 8);
    const context = await open(browser, baseURL, person.sessionFile);
    try {
      const row = await rows(await context.newPage(), goalId, width);
      await expect(row(thisMonth)).toContainText("en curso");
      await expect(row(thisMonth)).toContainText("2 tareas");
      expect(await row(thisMonth).innerText()).not.toContain("·");
    } finally {
      await context.close();
    }
  });
}

test("km goal, next month with one task and an amount names «planeado» and «1 tarea», and this month, empty, does not borrow it (RP-73)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta km futuro ${stamp}`, "km");
  await seedBudget(db, person.id, goalId, thisMonth, 40);
  await seedBudget(db, person.id, goalId, followingMonth, 30);
  await seedTask(db, person.id, goalId, `Futura ${stamp}`, followingMonth, 6);
  const context = await open(browser, baseURL, person.sessionFile);
  try {
    const row = await rows(await context.newPage(), goalId, 360);
    await expect(row(followingMonth)).toContainText("planeado");
    await expect(row(followingMonth)).toContainText("1 tarea");
    expect(await row(followingMonth).innerText()).not.toContain("·");
    await expect(row(followingMonth)).not.toContainText("1 tareas");
    await expect(row(thisMonth)).toContainText("en curso");
    await expect(row(thisMonth)).not.toContainText("tarea");
  } finally {
    await context.close();
  }
});

test("km goal: a task left undone from a past month counts in the current month, as its list shows it (RP-69)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta km arrastrada ${stamp}`, "km");
  await seedBudget(db, person.id, goalId, thisMonth, 40);
  await seedTask(db, person.id, goalId, `Vieja ${stamp}`, lastMonth, 7);
  await seedTask(db, person.id, goalId, `Propia ${stamp}`, thisMonth, 5);
  const context = await open(browser, baseURL, person.sessionFile);
  try {
    const page = await context.newPage();
    // The month's own list is the reference for how many it holds.
    await page.goto(`/metas/${goalId}/meses/${seg(thisMonth)}`);
    await expect(page.getByText(`Vieja ${stamp}`).first()).toBeVisible();
    await expect(page.getByText(`Propia ${stamp}`).first()).toBeVisible();
    const row = await rows(page, goalId, 360);
    await expect(row(thisMonth)).toContainText("en curso");
    await expect(row(thisMonth)).toContainText("2 tareas");
  } finally {
    await context.close();
  }
});

test("km goal, no task in any month: no row says «tarea» and none says «0 tareas» (RP-69)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta km sin tareas ${stamp}`, "km");
  await seedBudget(db, person.id, goalId, thisMonth, 40);
  await seedBudget(db, person.id, goalId, followingMonth, 30);
  const context = await open(browser, baseURL, person.sessionFile);
  try {
    const row = await rows(await context.newPage(), goalId, 360);
    for (const month of [lastMonth, thisMonth, followingMonth]) {
      await expect(row(month), month).toBeVisible();
      await expect(row(month), month).not.toContainText("tarea");
    }
    await expect(row(thisMonth)).toContainText("en curso");
    await expect(row(followingMonth)).toContainText("planeado");
  } finally {
    await context.close();
  }
});

test("km goal, empty month: the list does not say its tasks add time, and says what to do (RP-69, RP-65)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta km vacío ${stamp}`, "km");
  await seedBudget(db, person.id, goalId, thisMonth, 40);
  const context = await open(browser, baseURL, person.sessionFile);
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/metas/${goalId}/meses/${seg(thisMonth)}`);
    await expect(page.getByText(/no tiene tareas\. Escribe las que quieras hacer este mes\./).first()).toBeAttached();
    await expect(page.getByText("suman su tiempo")).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toContain("suman su tiempo");
  } finally {
    await context.close();
  }
});

test("minutes goal with no rhythm: only the month holding tasks says «2 tareas», and its empty month still says its tasks add time (RP-73, RP-32)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta min tareas ${stamp}`, "minutos");
  await seedBudget(db, person.id, goalId, thisMonth, 720);
  await seedTask(db, person.id, goalId, `Uno ${stamp}`, followingMonth, 60);
  await seedTask(db, person.id, goalId, `Dos ${stamp}`, followingMonth, 30);
  const context = await open(browser, baseURL, person.sessionFile);
  try {
    const page = await context.newPage();
    const row = await rows(page, goalId, 360);
    for (const month of [lastMonth, thisMonth]) {
      await expect(row(month), month).toBeVisible();
      await expect(row(month), month).not.toContainText("tarea");
    }
    await expect(row(followingMonth)).toContainText("2 tareas");
    await expect(row(thisMonth)).toContainText("en curso");
    await page.goto(`/metas/${goalId}/meses/${seg(thisMonth)}`);
    await expect(page.getByText(/suman su tiempo a la meta/).first()).toBeAttached();
  } finally {
    await context.close();
  }
});

// The widest a row's second line can be, split by line: every client rect of
// the text node «N tarea(s)» sits on one line when the number and its word stay together.
async function taskCountLines(row: import("@playwright/test").Locator, pattern: RegExp): Promise<number> {
  return row.evaluate((element, source) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const regex = new RegExp(source);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      const match = regex.exec(text);
      if (!match) continue;
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const tops = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top)));
      return tops.size;
    }
    return -1;
  }, pattern.source);
}

for (const width of [360, 390, 1440]) {
  test(`km goal: «N tareas» in a «Por mes» row never splits the number from its word at ${width} (RP-69)`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const goalId = await seedGoal(db, person.id, `Meta km sin corte ${stamp}`, "km");
    await seedBudget(db, person.id, goalId, thisMonth, 40);
    await seedBudget(db, person.id, goalId, followingMonth, 30);
    for (const [index, month] of [thisMonth, thisMonth, followingMonth, followingMonth].entries()) {
      await seedTask(db, person.id, goalId, `Tarea ${index} ${stamp}`, month, 3);
    }
    const context = await open(browser, baseURL, person.sessionFile);
    try {
      const page = await context.newPage();
      const row = await rows(page, goalId, width);
      for (const month of [thisMonth, followingMonth]) {
        const line = row(month);
        await expect(line).toContainText("2 tareas");
        expect(await taskCountLines(line, /2[\s\u00a0]tareas/), `${month}: the count is one unbroken run`).toBe(1);
        expect(await line.innerText()).toContain("2\u00a0tareas");
      }
    } finally {
      await context.close();
    }
  });
}

test("km goal: the month block reads «34 de 120 km», its unit once at the end (RP-69, 829)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta km unidad ${stamp}`, "km");
  await seedBudget(db, person.id, goalId, thisMonth, 120);
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${goalId}, ${`Salida ${stamp}`}, 'daily', 'quantity', 10, 'km', now() - interval '40 days')
    returning id`;
  await db`insert into goals.facts (user_id, goal_id, commitment_id, day, quantity) values (${person.id}, ${goalId}, ${commitment.id}, ${todayInZone()}::date, 34)`;
  const context = await open(browser, baseURL, person.sessionFile);
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`/metas/${goalId}`);
    const block = page.locator("main section", { hasText: /de\s+120/ }).first();
    await expect(block).toBeVisible();
    const text = (await block.innerText()).replace(/\s+/g, " ");
    expect(text).toMatch(/34 de 120 km/);
    expect(text).not.toMatch(/34 km de/);
  } finally {
    await context.close();
  }
});

test("km goal, a future month with no tasks and no amount: «sin monto planeado» alone, and the empty text names that month (RP-69)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta km mes futuro ${stamp}`, "km");
  await seedBudget(db, person.id, goalId, thisMonth, 40);
  const name = label(followingMonth);
  const context = await open(browser, baseURL, person.sessionFile);
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`/metas/${goalId}/meses/${seg(followingMonth)}`);
    await expect(page.locator("main").first()).toContainText("sin monto planeado");
    const body = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
    expect(body).toContain("sin monto planeado");
    expect(body).not.toMatch(/planeado\s*·?\s*0 km/i);
    expect(body).not.toMatch(/0 km sin monto planeado/);
    expect(body).toContain(`${name[0].toUpperCase()}${name.slice(1)} no tiene tareas. Escribe las que quieras hacer en ${name}.`);
    expect(body).not.toContain("hacer este mes");

    // The current month keeps its text.
    await page.goto(`/metas/${goalId}/meses/${seg(thisMonth)}`);
    await expect(page.locator("main").first()).toContainText("Escribe las que quieras hacer este mes.");
    expect((await page.locator("main").first().innerText()).replace(/\s+/g, " ")).toContain("Escribe las que quieras hacer este mes.");
  } finally {
    await context.close();
  }
});

async function seedBareGoal(db: Db, personId: string, name: string) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${name}, ${horizon}::date, (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
    returning id
  `;
  await seedTask(db, personId, goal.id, `Uno ${name}`, thisMonth, null);
  await seedTask(db, personId, goal.id, `Dos ${name}`, thisMonth, null);
  return goal.id;
}

test("goal with no measure: a «Por mes» row never splits «2 tareas» (RP-69)", async ({ person, browser, baseURL, db }) => {
  const goalId = await seedBareGoal(db, person.id, `Meta sin medida ${Date.now()}`);
  const context = await open(browser, baseURL, person.sessionFile);
  try {
    const page = await context.newPage();
    const row = await rows(page, goalId, 390);
    const line = row(thisMonth);
    await expect(line).toContainText(/2\s+tareas/);
    expect(await line.innerText()).toContain("2\u00a0tareas");
  } finally {
    await context.close();
  }
});

test("goal with no measure: the goal screen's «2 tareas · 0 hechas» never splits the number from its word (RP-69)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const goalId = await seedBareGoal(db, person.id, `Meta sin medida detalle ${Date.now()}`);
  const context = await open(browser, baseURL, person.sessionFile);
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`/metas/${goalId}`);
    const line = page.locator("main p", { hasText: /2\s+tareas\s+·/ }).first();
    await expect(line).toBeVisible();
    expect(await line.innerText()).toContain("2\u00a0tareas · ");
  } finally {
    await context.close();
  }
});

async function seedFact(db: Db, personId: string, goalId: string, name: string, day: string, quantity: number) {
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${personId}, ${goalId}, ${name}, 'daily', 'quantity', 10, 'km', now() - interval '60 days')
    returning id`;
  await db`insert into goals.facts (user_id, goal_id, commitment_id, day, quantity) values (${personId}, ${goalId}, ${commitment.id}, ${day}::date, ${quantity})`;
}

async function monthText(page: import("@playwright/test").Page, goalId: string, month: string) {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`/metas/${goalId}/meses/${seg(month)}`);
  const main = page.locator("main").first();
  await expect(main).toBeVisible();
  return async () => (await main.innerText()).replace(/\s+/g, " ");
}

test("goal with no measure, empty month: a later month says «hacer en <mes>», the current one «este mes» (RP-69)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`Meta sin medida vacía ${Date.now()}`}, ${horizon}::date, (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
    returning id`;
  const name = label(followingMonth);
  const context = await open(browser, baseURL, person.sessionFile);
  try {
    const page = await context.newPage();
    const later = await monthText(page, goal.id, followingMonth);
    await expect(page.locator("main").first()).toContainText(`Escribe las que quieras hacer en ${name}.`);
    expect(await later()).not.toContain("hacer este mes");
    const current = await monthText(page, goal.id, thisMonth);
    await expect(page.locator("main").first()).toContainText("Escribe las que quieras hacer este mes.");
    expect(await current()).not.toMatch(/hacer en \p{L}+\./u);
  } finally {
    await context.close();
  }
});

test("km goal, this month with no amount: the block keeps «este mes» and what is reached beside «sin monto planeado» (RP-69)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta km actual sin monto ${stamp}`, "km");
  await seedFact(db, person.id, goalId, `Salida ${stamp}`, todayInZone(), 3);
  const context = await open(browser, baseURL, person.sessionFile);
  try {
    const page = await context.newPage();
    const text = await monthText(page, goalId, thisMonth);
    await expect(page.locator("main").first()).toContainText("sin monto planeado");
    const body = await text();
    expect(body).toContain("este mes");
    expect(body).toMatch(/3 km/);
  } finally {
    await context.close();
  }
});

test("km goal, a closed month with no amount: the block keeps «cerrado» and what was reached (RP-69)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta km cerrado sin monto ${stamp}`, "km");
  await seedFact(db, person.id, goalId, `Salida ${stamp}`, `${seg(lastMonth)}-15`, 7);
  const context = await open(browser, baseURL, person.sessionFile);
  try {
    const page = await context.newPage();
    const text = await monthText(page, goalId, lastMonth);
    await expect(page.locator("main").first()).toContainText("cerrado");
    const body = await text();
    expect(body).toContain("sin monto planeado");
    expect(body).toMatch(/7 km/);
  } finally {
    await context.close();
  }
});

test("minutes goal, a future month with no amount: the block is «sin monto planeado» alone (RP-69, RP-32)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta min futuro sin monto ${stamp}`, "minutos");
  await seedBudget(db, person.id, goalId, thisMonth, 720);
  const context = await open(browser, baseURL, person.sessionFile);
  try {
    const page = await context.newPage();
    const text = await monthText(page, goalId, followingMonth);
    await expect(page.locator("main").first()).toContainText("sin monto planeado");
    expect(await text()).not.toMatch(/0 min/);
  } finally {
    await context.close();
  }
});

test("km goal, a future month with no amount: «planeado» appears once, inside «sin monto planeado» (RP-69)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta km planeado único ${stamp}`, "km");
  await seedBudget(db, person.id, goalId, thisMonth, 40);
  const context = await open(browser, baseURL, person.sessionFile);
  try {
    const page = await context.newPage();
    await monthText(page, goalId, followingMonth);
    // The phrase sits in a row inside the month block; the block is its parent's parent.
    const block = page.getByText("sin monto planeado", { exact: true }).locator("xpath=../..");
    await expect(block).toBeVisible();
    expect(((await block.innerText()).match(/planeado/gi) ?? []).length).toBe(1);
  } finally {
    await context.close();
  }
});
