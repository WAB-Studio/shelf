import type { Locator } from "@playwright/test";

import { test, expect } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";
import monthMessages from "../messages/es/month.json";
import { boxOf } from "./box";

const owesLine = (month: string, owes: string) =>
  monthMessages.list.owes.replace(/<\/?fig>/g, "").replace("{month}", month).replace("{owes}", owes);

// `Mes`, `MesArrastre`, `MesVacio`, `MesCerrado` (RP-30,
// RP-31, RP-32): one month of a goal, its carried tasks first. Calendar-bound
// as 135: the seeded «last month» is always the month before today.

// A mixed line: its sentence in Archivo, each figure (a span) in mono.
async function expectFigures(line: Locator, figures: string[]) {
  const set = await line.evaluate((el) => ({
    line: getComputedStyle(el).fontFamily,
    spans: Array.from(el.querySelectorAll("span")).map((span) => ({
      text: span.textContent,
      family: getComputedStyle(span).fontFamily,
    })),
  }));
  expect(set.line).not.toMatch(/mono/i);
  expect(set.spans.map((span) => span.text)).toEqual(figures);
  for (const span of set.spans) expect(span.family).toMatch(/mono/i);
}

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

function label(month: string): string {
  return NAMES[Number(month.slice(5, 7)) - 1];
}

const thisMonth = monthOf(todayInZone());
const lastMonth = monthOf(dayBefore(thisMonth));
const twoBack = monthOf(dayBefore(lastMonth));
const following = nextMonth(thisMonth);
const horizon = nextMonth(following);
const seg = (month: string) => month.slice(0, 7);

type Db = import("postgres").Sql;

async function seedGoal(db: Db, personId: string, name: string, openedIn = lastMonth, measure = true) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${name}, ${horizon}::date, ${measure ? "minutos" : null}, ${measure ? "minutos" : null}, (${openedIn}::date + 14) + time '12:00' at time zone 'UTC')
    returning id
  `;
  return goal.id;
}

async function seedBudget(db: Db, personId: string, goalId: string, month: string, amount: number) {
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${personId}, ${goalId}, ${month}::date, ${amount})
  `;
}

async function seedTask(
  db: Db,
  personId: string,
  goalId: string,
  name: string,
  month: string | null,
  estimate: number | null,
  parentId: string | null = null,
  doneOn: string | null = null,
) {
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate, parent_id)
    values (${personId}, ${goalId}, ${name}, ${month === null ? null : db`${month}::date`}, ${estimate}, ${parentId})
    returning id
  `;
  if (doneOn !== null) {
    await db`
      insert into goals.facts (user_id, goal_id, one_off_id, day)
      values (${personId}, ${goalId}, ${task.id}, ${doneOn}::date)
    `;
  }
  return task.id;
}

test("this month lists the carried parent first, then its own task; marking the child done keeps the parent on the list as done; last month shows its share and adds nothing; a month outside the span is not found (RP-30, RP-31, RP-32)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta mes ${stamp}`);
  await seedBudget(db, person.id, goalId, lastMonth, 720);
  await seedBudget(db, person.id, goalId, thisMonth, 720);
  const parent = await seedTask(db, person.id, goalId, `Padre ${stamp}`, lastMonth, null);
  await seedTask(db, person.id, goalId, `Hijo hecho ${stamp}`, null, 60, parent, `${lastMonth.slice(0, 8)}15`);
  await seedTask(db, person.id, goalId, `Hijo pendiente ${stamp}`, null, 180, parent);
  await seedTask(db, person.id, goalId, `Propia ${stamp}`, thisMonth, 120);

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });

    await page.goto(`/metas/${goalId}/meses/${seg(thisMonth)}`);
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByRole("link", { name: `Volver a Meta mes ${stamp}` })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    const title = `${label(thisMonth).charAt(0).toUpperCase() + label(thisMonth).slice(1)} ${thisMonth.slice(0, 4)}`;
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await expect(page.getByText("este mes", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "de 12 h", exact: true })).toBeVisible();

    // Carried first: its section precedes the month's own, and the parent
    // reads what it still owes.
    const carriedSection = page.getByText(`de ${label(lastMonth)}`, { exact: true });
    const ownSection = page.getByText(/^de .* · 2 h$/);
    await expect(carriedSection).toBeVisible();
    await expect(ownSection).toBeVisible();
    const carriedBox = await carriedSection.boundingBox();
    const ownBox = await ownSection.boundingBox();
    expect(carriedBox!.y).toBeLessThan(ownBox!.y);
    const parentRow = page.locator("[data-done]");
    await expect(parentRow).toHaveCount(1);
    await expect(parentRow).toContainText(`Padre ${stamp}`);
    await expect(parentRow).toContainText(owesLine(label(lastMonth), "3 h"));
    await expect(parentRow).toHaveAttribute("data-done", "false");
    // The parent has no mark of its own: only the leaves do.
    await expect(parentRow.locator("[data-state]")).toHaveCount(0);
    // Two children and the own task, plus the dashed mark of the add link.
    await expect(page.locator("[data-state]")).toHaveCount(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    const add = page.getByRole("link", { name: `Otra tarea de ${label(thisMonth)}` });
    await expect(add).toHaveAttribute("href", `/metas/${goalId}/meses/${seg(thisMonth)}/tarea/nueva`);

    // The first undone mark is the pending child's: carried rows lead.
    await page.getByRole("button", { name: "Marcar como hecho" }).first().click();
    await expect(parentRow).toHaveAttribute("data-done", "true");
    await expect(page.locator("[data-state=declared]")).toHaveCount(2);
    await expect(parentRow).toContainText(`Padre ${stamp}`);
    // The done task's 3 h add nothing to the month: hours come from blocks alone (RP-128).
    await expect(page.getByText(/incluye .* de tareas hechas/)).toHaveCount(0);
    expect((await page.locator("main").innerText()).replace(/\s+/g, " ")).toContain("0 min de 12 h");

    // Undone again with no reload: the done child is the one to take back.
    await page.getByRole("button", { name: `Deshacer: Hijo pendiente ${stamp}` }).click();
    await expect(parentRow).toHaveAttribute("data-done", "false");

    // Last month: closed, its share, nothing to add.
    await page.goto(`/metas/${goalId}/meses/${seg(lastMonth)}`);
    await expect(page.getByText("cerrado", { exact: true })).toBeVisible();
    const closedLine = monthMessages.list.closedLineTo
      .replace(/<\/?fig>/g, "")
      .replace("{share}", "75")
      .replace("{next}", label(thisMonth))
      .replace("{owed}", "3 h")
      .replace("{planned}", "4 h");
    await expect(page.getByText(closedLine)).toBeVisible();
    await expectFigures(page.getByText(closedLine), ["75 %", "3 h", "4 h"]);
    await expect(page.getByText("Un mes cerrado no toma tareas nuevas.")).toBeVisible();
    await expect(page.getByRole("link", { name: /Otra tarea|Escribir una tarea/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Escribir una tarea/ })).toHaveCount(0);

    // Outside the span, and not a month at all.
    for (const mes of [seg(nextMonth(horizon)), seg(twoBack), "2026-13", "abril"]) {
      await page.goto(`/metas/${goalId}/meses/${mes}`);
      await expect(page.getByRole("heading", { name: "Esta página no existe" }), mes).toBeVisible();
    }
  } finally {
    await context.close();
  }
});

test("an empty month says so and offers the first task (RP-30)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta vacío ${stamp}`);
  await seedBudget(db, person.id, goalId, thisMonth, 720);

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/metas/${goalId}/meses/${seg(thisMonth)}`);
    // The list beside the month is in the markup and hidden at 360.
    await expect(page.getByText("0 min", { exact: true }).and(page.locator(":visible"))).toBeVisible();
    await expect(page.getByText(/no tiene tareas\. Las que escribas aquí suman su tiempo a la meta/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Escribir una tarea" })).toHaveAttribute(
      "href",
      `/metas/${goalId}/meses/${seg(thisMonth)}/tarea/nueva`,
    );
  } finally {
    await context.close();
  }
});

test("a carried task with no estimate reads «de <mes>» alone and one with time «debe»; next month lists neither (RP-30, RP-31)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta debe ${stamp}`);
  await seedBudget(db, person.id, goalId, thisMonth, 720);
  await seedTask(db, person.id, goalId, `Sin monto ${stamp}`, lastMonth, null);
  await seedTask(db, person.id, goalId, `Con monto ${stamp}`, lastMonth, 315);

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/metas/${goalId}/meses/${seg(thisMonth)}`);
    const bare = page.getByText(`Sin monto ${stamp}`).locator("xpath=ancestor::button[1]");
    const owed = page.getByText(`Con monto ${stamp}`).locator("xpath=ancestor::button[1]");
    await expect(bare).toContainText(`de ${label(lastMonth)}`);
    await expect(bare).not.toContainText("debe");
    await expect(bare).not.toContainText("0 min");
    await expect(owed).toContainText(owesLine(label(lastMonth), "5 h 15 min"));

    if (following.slice(0, 7) <= horizon.slice(0, 7)) {
      await page.goto(`/metas/${goalId}/meses/${seg(following)}`);
      await expect(page.getByText(`Sin monto ${stamp}`)).toHaveCount(0);
      await expect(page.getByText(`Con monto ${stamp}`)).toHaveCount(0);
    }
  } finally {
    await context.close();
  }
});

test("a goal with no measure's empty month promises no time; the back and «Todos los meses» each reach their page (RP-30, RP-31)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta lisa ${stamp}`, lastMonth, false);

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 740 });
      const url = `/metas/${goalId}/meses/${seg(thisMonth)}`;
      await page.goto(url);
      await expect(page.getByText(/no tiene tareas\./)).toBeVisible();
      await expect(page.locator("main")).not.toContainText(/tiempo/i);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

      const back = page.getByRole("link", { name: `Volver a Meta lisa ${stamp}` });
      const arrow = (await boxOf(back));
      expect(arrow.width).toBeGreaterThanOrEqual(44);
      expect(arrow.height).toBeGreaterThanOrEqual(44);
      const all = page.getByRole("link", { name: "Todos los meses" });
      expect((await boxOf(all)).height).toBeGreaterThanOrEqual(44);

      await back.click();
      await expect(page).toHaveURL(new RegExp(`/metas/${goalId}$`));
      await page.goto(url);
      await all.click();
      await expect(page).toHaveURL(new RegExp(`/metas/${goalId}/meses$`));
    }
  } finally {
    await context.close();
  }
});

test("from 1024 the goal's months stand beside the month and tapping another swaps the detail while the list stays; every month row is a whole 48 px link in ink (RP-31, RP-32, RNP-16)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta lado ${stamp}`);
  await seedBudget(db, person.id, goalId, lastMonth, 720);
  await seedBudget(db, person.id, goalId, thisMonth, 720);
  await seedTask(db, person.id, goalId, `Pasada ${stamp}`, lastMonth, 60);
  await seedTask(db, person.id, goalId, `Propia ${stamp}`, thisMonth, 120);

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    for (const width of [360, 390, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/metas/${goalId}/meses/${seg(thisMonth)}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      const rows = page.locator("main ol a:visible");
      if (width < 1024) {
        await expect(rows).toHaveCount(0);
        continue;
      }
      await expect(rows).toHaveCount(3);
      for (const row of await rows.all()) {
        expect((await boxOf(row)).height).toBeGreaterThanOrEqual(48);
        expect(await row.evaluate((node) => getComputedStyle(node).color)).not.toBe("rgb(0, 0, 238)");
      }
      const opened = page.locator("main ol a[aria-current=page]");
      await expect(opened).toContainText(label(thisMonth));
      await expect(page.getByText(`Propia ${stamp}`)).toBeVisible();
      const listBox = (await boxOf(rows.first()));
      const detailBox = (await boxOf(page.getByText(`Propia ${stamp}`)));
      expect(listBox.x + listBox.width).toBeLessThan(detailBox.x);

      await page.locator("main ol a", { hasText: label(lastMonth) }).click();
      await page.waitForURL(`**/meses/${seg(lastMonth)}`);
      await expect(page.getByText(`Pasada ${stamp}`)).toBeVisible();
      await expect(page.getByText(`Propia ${stamp}`)).toHaveCount(0);
      await expect(rows).toHaveCount(3);
      await expect(page.locator("main ol a[aria-current=page]")).toContainText(label(lastMonth));
    }
  } finally {
    await context.close();
  }
});
