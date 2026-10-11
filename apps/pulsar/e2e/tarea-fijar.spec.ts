import type { Page } from "@playwright/test";

import { test, expect } from "./fixtures";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// `RoadmapFijar` (RP-51, RP-54, RP-55, RP-22): a task's name opens
// its sheet, where it is renamed, re-estimated and fixed to a month, and where
// «Borrar la tarea» waits at the foot. Calendar-bound: «this month» is the
// current one, the goal runs three months past it.

const NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const label = (month: string) => NAMES[Number(month.slice(5, 7)) - 1];

const today = todayInZone();
const thisMonth = monthOf(today);
const later = nextMonth(thisMonth);
const last = nextMonth(later);
const horizon = nextMonth(last);
const seg = (month: string) => month.slice(0, 7);

type Db = import("postgres").Sql;

async function seedGoal(db: Db, personId: string, stamp: number, rhythm: number | null) {
  // Opened on the 1st, Bogotá's midnight: this month plans its whole rhythm (RP-74) whatever the run date.
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${personId}, ${`Meta fijar ${stamp}`}, ${horizon}::date, 'minutos', 'minutos', ${rhythm}, date_trunc('month', now() at time zone 'America/Bogota') at time zone 'America/Bogota')
    returning id
  `;
  return { goalId: goal.id, goalName: `Meta fijar ${stamp}` };
}

async function seedTask(db: Db, personId: string, goalId: string, name: string, estimate: number | null, fixed: string | null) {
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, estimate, planned_month, in_plan)
    values (${personId}, ${goalId}, ${name}, ${estimate}, ${fixed}::date, true)
    returning id
  `;
  return task.id;
}

async function row(db: Db, taskId: string) {
  const [one] = await db<{ name: string; estimate: number | null; planned_month: string | null }[]>`
    select name, estimate, to_char(planned_month, 'YYYY-MM-DD') as planned_month from goals.one_offs where id = ${taskId}
  `;
  return one;
}

for (const width of [390, 1440]) {
  test.describe(`at ${width}`, () => {
    async function open(browser: import("@playwright/test").Browser, baseURL: string, sessionFile: string, path: string) {
      const context = await browser.newContext({ storageState: sessionFile, baseURL, viewport: { width, height: 900 } });
      const page = await context.newPage();
      await page.goto(path);
      return { context, page };
    }
    const nameButton = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name}`) });

    test("rename: the name opens the sheet, never «¿Borrarla?», and the new name is written (RP-55)", async ({ person, browser, baseURL, db }) => {
      const stamp = Date.now();
      const { goalId, goalName } = await seedGoal(db, person.id, stamp, null);
      const name = `Tarea renombrar ${stamp}`;
      const taskId = await seedTask(db, person.id, goalId, name, 60, thisMonth);
      const { context, page } = await open(browser, baseURL!, person.sessionFile, `/metas/${goalId}/meses/${seg(thisMonth)}`);
      try {
        await nameButton(page, name).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet.getByRole("heading", { name })).toBeVisible();
        await expect(sheet).toContainText(`tarea · ${goalName}`);
        await expect(sheet).not.toContainText("¿Borrarla?");
        await sheet.getByLabel("Nombre").fill(`${name} nueva`);
        await sheet.getByRole("button", { name: "Guardar" }).click();
        await expect(sheet).toBeHidden();
        expect((await row(db, taskId)).name).toBe(`${name} nueva`);
        await expect(nameButton(page, `${name} nueva`)).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("re-estimate: a smaller first task pulls the second whole into this month (RP-54)", async ({ person, browser, baseURL, db }) => {
      const stamp = Date.now();
      const { goalId } = await seedGoal(db, person.id, stamp, 120);
      const first = `Primera ${stamp}`;
      const second = `Segunda ${stamp}`;
      const firstId = await seedTask(db, person.id, goalId, first, 90, null);
      const secondId = await seedTask(db, person.id, goalId, second, 90, null);
      const { context, page } = await open(browser, baseURL!, person.sessionFile, "/mes");
      try {
        const split = page.getByRole("button", { name: new RegExp(`^${second}`) });
        await expect(split).toContainText(`Empieza aquí con 30 min y sigue en ${label(later)}.`);
        await expect(split).toContainText("30 min de 1 h 30 min");

        await nameButton(page, first).click();
        const sheet = page.getByRole("dialog");
        await sheet.getByLabel("Cuánto le calculas").fill("0");
        await sheet.getByRole("spinbutton", { name: "min" }).fill("30");
        await sheet.getByRole("button", { name: "Guardar" }).click();
        await expect(sheet).toBeHidden();
        expect((await row(db, firstId)).estimate).toBe(30);
        await expect(split).not.toContainText("sigue en");
        await expect(split).toContainText("1 h 30 min");
        expect((await row(db, secondId)).estimate).toBe(90);
      } finally {
        await context.close();
      }
    });

    test("fix to a month: it reads «Fijada en …» there and leaves this month; «Lo pone el plan» returns it (RP-51)", async ({ person, browser, baseURL, db }) => {
      const stamp = Date.now();
      const { goalId } = await seedGoal(db, person.id, stamp, 600);
      const name = `Tarea fijar ${stamp}`;
      const taskId = await seedTask(db, person.id, goalId, name, 60, null);
      const { context, page } = await open(browser, baseURL!, person.sessionFile, "/mes");
      try {
        await nameButton(page, name).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet.getByRole("radio", { name: /^Lo pone el plan/ })).toHaveAttribute("aria-checked", "true");
        await expect(sheet).toContainText(`hoy: ${label(thisMonth)}`);
        await expect(sheet).toContainText("Una tarea fijada no se mueve con el plan. Las demás se acomodan alrededor.");
        await sheet.getByRole("radio", { name: "Fijarla en" }).click();
        await sheet.getByRole("radio", { name: label(last) }).click();
        await sheet.getByRole("button", { name: "Guardar" }).click();
        await expect(sheet).toBeHidden();
        expect((await row(db, taskId)).planned_month).toBe(last);

        await expect(nameButton(page, name)).toHaveCount(0);
        await page.goto(`/metas/${goalId}/meses/${seg(last)}`);
        await expect(nameButton(page, name)).toContainText(`Fijada en ${label(last)}`);

        await nameButton(page, name).click();
        await expect(sheet.getByRole("radio", { name: "Fijarla en" })).toHaveAttribute("aria-checked", "true");
        await sheet.getByRole("radio", { name: /^Lo pone el plan/ }).click();
        await sheet.getByRole("button", { name: "Guardar" }).click();
        await expect(sheet).toBeHidden();
        expect((await row(db, taskId)).planned_month).toBeNull();
        await page.goto("/mes");
        await expect(nameButton(page, name)).toBeVisible();
        await expect(nameButton(page, name)).not.toContainText("Fijada en");
      } finally {
        await context.close();
      }
    });

    test("a goal with no rhythm draws no pin on any row, and its sheet still holds «Fijarla en» (RP-51)", async ({ person, browser, baseURL, db }) => {
      const stamp = Date.now();
      const { goalId } = await seedGoal(db, person.id, stamp, null);
      const name = `Tarea sin ritmo ${stamp}`;
      await seedTask(db, person.id, goalId, name, 60, thisMonth);
      const { context, page } = await open(browser, baseURL!, person.sessionFile, `/metas/${goalId}/meses/${seg(thisMonth)}`);
      try {
        await expect(nameButton(page, name)).toBeVisible();
        await expect(page.getByText("Fijada en")).toHaveCount(0);
        await nameButton(page, name).click();
        await expect(page.getByRole("dialog").getByRole("radio", { name: "Fijarla en" })).toHaveAttribute("aria-checked", "true");
      } finally {
        await context.close();
      }
    });

    test("a month change on a task with a day is refused at the month field (RP-51)", async ({ person, browser, baseURL, db }) => {
      const stamp = Date.now();
      const { goalId } = await seedGoal(db, person.id, stamp, 600);
      const name = `Tarea con día ${stamp}`;
      const taskId = await seedTask(db, person.id, goalId, name, 60, thisMonth);
      await db`update goals.one_offs set day = ${today}::date where id = ${taskId}`;
      const { context, page } = await open(browser, baseURL!, person.sessionFile, `/metas/${goalId}/meses/${seg(thisMonth)}`);
      try {
        await nameButton(page, name).click();
        const sheet = page.getByRole("dialog");
        await sheet.getByRole("radio", { name: label(last) }).click();
        await sheet.getByRole("button", { name: "Guardar" }).click();
        await expect(sheet.getByRole("radiogroup").getByRole("alert")).toContainText("Esa tarea tiene día");
        expect((await row(db, taskId)).planned_month).toBe(thisMonth);
      } finally {
        await context.close();
      }
    });

    test("saving a rename on a done task lands (RP-55)", async ({ person, browser, baseURL, db }) => {
      const stamp = Date.now();
      const { goalId } = await seedGoal(db, person.id, stamp, null);
      const name = `Tarea hecha renombrar ${stamp}`;
      const taskId = await seedTask(db, person.id, goalId, name, 60, thisMonth);
      await db`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${person.id}, ${goalId}, ${taskId}, ${today}::date)`;
      const { context, page } = await open(browser, baseURL!, person.sessionFile, `/metas/${goalId}/meses/${seg(thisMonth)}`);
      try {
        await nameButton(page, name).click();
        const sheet = page.getByRole("dialog");
        await sheet.getByLabel("Nombre").fill(`${name} nueva`);
        await sheet.getByRole("button", { name: "Guardar" }).click();
        await expect(sheet).toBeHidden();
        const saved = await row(db, taskId);
        expect(saved.name).toBe(`${name} nueva`);
        expect(saved.estimate).toBe(60);
      } finally {
        await context.close();
      }
    });

    test("a done task's sheet offers its name alone (RP-55)", async ({ person, browser, baseURL, db }) => {
      const stamp = Date.now();
      const { goalId } = await seedGoal(db, person.id, stamp, null);
      const name = `Tarea hecha ${stamp}`;
      const taskId = await seedTask(db, person.id, goalId, name, 60, thisMonth);
      await db`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${person.id}, ${goalId}, ${taskId}, ${today}::date)`;
      const { context, page } = await open(browser, baseURL!, person.sessionFile, `/metas/${goalId}/meses/${seg(thisMonth)}`);
      try {
        await nameButton(page, name).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet.getByLabel("Nombre")).toBeVisible();
        await expect(sheet.getByLabel("Cuánto le calculas")).toHaveCount(0);
        await expect(sheet.getByText("Mes", { exact: true })).toHaveCount(0);
        await expect(sheet.getByRole("button", { name: "Borrar la tarea" })).toHaveCount(0);
        await expect(sheet).not.toContainText("¿Borrarla?");
      } finally {
        await context.close();
      }
    });

    test("«Borrar la tarea» is offered on a plain task and opens «¿Borrarla?»; a parent with a done sub-task has none (RP-22)", async ({ person, browser, baseURL, db }) => {
      const stamp = Date.now();
      const { goalId } = await seedGoal(db, person.id, stamp, null);
      const plain = `Tarea suelta ${stamp}`;
      const parent = `Tarea madre ${stamp}`;
      await seedTask(db, person.id, goalId, plain, 30, thisMonth);
      const parentId = await seedTask(db, person.id, goalId, parent, null, thisMonth);
      const [child] = await db<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, estimate, parent_id)
        values (${person.id}, ${goalId}, ${`Hija ${stamp}`}, 20, ${parentId}) returning id
      `;
      await db`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${person.id}, ${goalId}, ${child.id}, ${today}::date)`;
      const { context, page } = await open(browser, baseURL!, person.sessionFile, `/metas/${goalId}/meses/${seg(thisMonth)}`);
      try {
        await nameButton(page, parent).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet.getByLabel("Nombre")).toBeVisible();
        await expect(sheet.getByRole("button", { name: "Borrar la tarea" })).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(sheet).toBeHidden();

        await nameButton(page, plain).click();
        await expect(sheet.getByRole("button", { name: "Borrar la tarea" })).toBeVisible();
        await expect(sheet).not.toContainText("¿Borrarla?");
        await sheet.getByRole("button", { name: "Borrar la tarea" }).click();
        await expect(page.getByRole("dialog")).toContainText("¿Borrarla?");
      } finally {
        await context.close();
      }
    });

    test("the «min» box sits on the «h» box's top (RP-55)", async ({ person, browser, baseURL, db }) => {
      const stamp = Date.now();
      const { goalId } = await seedGoal(db, person.id, stamp, 600);
      const name = `Tarea alinear ${stamp}`;
      await seedTask(db, person.id, goalId, name, 90, null);
      const { context, page } = await open(browser, baseURL!, person.sessionFile, `/metas/${goalId}/meses/${seg(thisMonth)}`);
      try {
        await nameButton(page, name).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet).toBeVisible();
        // The sheet slides in; a box read mid-slide differs by the frame's travel.
        await sheet.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)));
        const hours = await sheet.getByLabel("Cuánto le calculas").boundingBox();
        const minutes = await sheet.getByRole("spinbutton", { name: "min" }).boundingBox();
        expect(Math.abs(hours!.y - minutes!.y)).toBeLessThanOrEqual(1);
      } finally {
        await context.close();
      }
    });

    test("a new task of the goal with no name says «Ponle un nombre.», never the loose task's words", async ({ person, browser, baseURL, db }) => {
      const stamp = Date.now();
      const { goalId } = await seedGoal(db, person.id, stamp, 600);
      await seedTask(db, person.id, goalId, `Tarea base ${stamp}`, 60, null);
      const { context, page } = await open(browser, baseURL!, person.sessionFile, `/metas/${goalId}/plan`);
      try {
        await page.getByRole("button", { name: "Añadir una tarea" }).click();
        const sheet = page.getByRole("dialog");
        await sheet.getByRole("button", { name: "Guardar" }).click();
        await expect(sheet).toContainText("Ponle un nombre.");
        await expect(sheet).not.toContainText("Escribe qué es lo suelto.");
      } finally {
        await context.close();
      }
    });

    test("a parent's sheet says it sums its sub-tasks and asks no estimate", async ({ person, browser, baseURL, db }) => {
      const stamp = Date.now();
      const { goalId } = await seedGoal(db, person.id, stamp, 600);
      const parent = `Tarea madre suma ${stamp}`;
      const parentId = await seedTask(db, person.id, goalId, parent, null, thisMonth);
      await db`
        insert into goals.one_offs (user_id, goal_id, name, estimate, parent_id)
        values (${person.id}, ${goalId}, ${`Hija suma ${stamp}`}, 20, ${parentId})
      `;
      const { context, page } = await open(browser, baseURL!, person.sessionFile, `/metas/${goalId}/meses/${seg(thisMonth)}`);
      try {
        await nameButton(page, parent).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet).toContainText("Suma lo de sus sub-tareas.");
        await expect(sheet.getByLabel("Cuánto le calculas")).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("a task fixed to a closed month shows that month as the selected chip, and saving unchanged keeps it", async ({ person, browser, baseURL, db }) => {
      const stamp = Date.now();
      const { goalId } = await seedGoal(db, person.id, stamp, 600);
      const name = `Tarea mes cerrado ${stamp}`;
      const closedMonth = (() => {
        const date = new Date(`${thisMonth}T12:00:00Z`);
        date.setUTCMonth(date.getUTCMonth() - 1);
        return date.toISOString().slice(0, 10);
      })();
      await db`update goals.goals set created_at = '2020-01-01T00:00:00Z'::timestamptz where id = ${goalId}`;
      const taskId = await seedTask(db, person.id, goalId, name, 60, closedMonth);
      const { context, page } = await open(browser, baseURL!, person.sessionFile, `/metas/${goalId}/meses/${seg(closedMonth)}`);
      try {
        await nameButton(page, name).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet.getByRole("radio", { name: "Fijarla en" })).toHaveAttribute("aria-checked", "true");
        await expect(sheet.getByRole("radio", { name: label(closedMonth) })).toHaveAttribute("aria-checked", "true");
        await sheet.getByRole("button", { name: "Guardar" }).click();
        await expect(sheet).toBeHidden();
        expect((await row(db, taskId)).planned_month).toBe(closedMonth);
      } finally {
        await context.close();
      }
    });
  });
}
