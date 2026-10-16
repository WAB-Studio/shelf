import type { Browser, Page, Request } from "@playwright/test";

import { test, expect } from "./fixtures";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// Module 663 (RP-65, RP-55): in a goal whose unit is not time, a task's sheet
// asks name and month alone and the month's «new task» form asks the name
// alone. Neither offers «Cuánto le calculas» nor «cuánto, en km». A goal in
// minutes keeps hours and minutes. Calendar-bound: «this month» is the current
// one and the goal runs three months past it.

const NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const label = (month: string) => NAMES[Number(month.slice(5, 7)) - 1];

const today = todayInZone();
const thisMonth = monthOf(today);
const later = nextMonth(thisMonth);
const last = nextMonth(later);
const horizon = nextMonth(last);
const seg = (month: string) => month.slice(0, 7);

const UNTIMED_SENTENCE = "Se queda en el mes que elijas. Esta meta no mide tiempo, así que ningún plan la mueve.";
const NO_MEASURE_CHILDREN = "se da por hecha cuando lo están sus sub-tareas";
const TIME_CHILDREN = "su tiempo sale de las sub-tareas";

type Db = import("postgres").Sql;
type Unit = "km" | "paginas" | "minutos";

async function seed(db: Db, personId: string, unit: Unit, estimate: number | null, options: { done?: boolean; day?: boolean } = {}) {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${`Correr 10K ${stamp}`}, ${horizon}::date, ${unit}, ${unit}, now() - interval '3 days')
    returning id
  `;
  const name = `Comprar zapatillas ${stamp}`;
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, estimate, planned_month, in_plan)
    values (${personId}, ${goal.id}, ${name}, ${estimate}, ${thisMonth}::date, true)
    returning id
  `;
  if (options.done) {
    await db`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${personId}, ${goal.id}, ${task.id}, ${today}::date)`;
  }
  if (options.day) await db`update goals.one_offs set day = ${today}::date where id = ${task.id}`;
  return { goalId: goal.id, goalName: `Correr 10K ${stamp}`, taskId: task.id, name };
}

async function stored(db: Db, taskId: string) {
  const [one] = await db<{ name: string; estimate: number | null; planned_month: string | null }[]>`
    select name, estimate, to_char(planned_month, 'YYYY-MM-DD') as planned_month from goals.one_offs where id = ${taskId}
  `;
  return one;
}

// Every server action is a POST carrying a `next-action` header.
function actions(page: Page) {
  const seen: Request[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"] !== undefined) seen.push(request);
  });
  return seen;
}

for (const width of [390, 1440]) {
  test.describe(`at ${width}`, () => {
    async function visit(browser: Browser, baseURL: string, sessionFile: string, path: string) {
      const context = await browser.newContext({ storageState: sessionFile, baseURL, viewport: { width, height: 900 } });
      const page = await context.newPage();
      await page.goto(path);
      return { context, page };
    }
    async function openSheet(browser: Browser, baseURL: string, sessionFile: string, goalId: string, name: string) {
      const { context, page } = await visit(browser, baseURL, sessionFile, `/metas/${goalId}/meses/${seg(thisMonth)}`);
      await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
      const sheet = page.getByRole("dialog");
      await expect(sheet.getByLabel("Nombre")).toBeVisible();
      return { context, page, sheet };
    }

    for (const unit of ["km", "paginas"] as const) {
      test(`sheet, ${unit}: name and month alone, no estimate field, no unit suffix (RP-65)`, async ({ person, browser, baseURL, db }) => {
        const { goalId, goalName, name } = await seed(db, person.id, unit, 5);
        const { context, sheet } = await openSheet(browser, baseURL!, person.sessionFile, goalId, name);
        try {
          await expect(sheet).toContainText(`tarea · ${goalName}`);
          await expect(sheet.getByRole("heading", { name })).toBeVisible();
          await expect(sheet.getByText("Mes", { exact: true })).toBeVisible();
          await expect(sheet.getByRole("radio", { name: label(thisMonth), exact: true })).toHaveAttribute("aria-checked", "true");
          await expect(sheet).toContainText(UNTIMED_SENTENCE);
          await expect(sheet.getByLabel("Cuánto le calculas")).toHaveCount(0);
          await expect(sheet.getByRole("spinbutton")).toHaveCount(0);
          await expect(sheet.getByText(unit, { exact: true })).toHaveCount(0);
          await expect(sheet).not.toContainText("Cuánto le calculas");
          await expect(sheet.getByText("Lo pone el plan")).toHaveCount(0);
          await expect(sheet.getByText("Fijarla en")).toHaveCount(0);
        } finally {
          await context.close();
        }
      });
    }

    test("sheet, km, pending task with an estimate stored from before: a rename sends no estimate and keeps the stored one (RP-65)", async ({ person, browser, baseURL, db }) => {
      const { goalId, taskId, name } = await seed(db, person.id, "km", 5);
      const { context, page, sheet } = await openSheet(browser, baseURL!, person.sessionFile, goalId, name);
      const posts = actions(page);
      try {
        await sheet.getByLabel("Nombre").fill(`${name} nueva`);
        await sheet.getByRole("button", { name: "Guardar" }).click();
        await expect(sheet).toBeHidden();
        expect(posts.length).toBeGreaterThan(0);
        const bodies = posts.map((request) => request.postData() ?? "");
        expect(bodies.some((body) => body.includes(`${name} nueva`))).toBe(true);
        for (const body of bodies) expect(body).not.toContain("estimate");
        const saved = await stored(db, taskId);
        expect(saved.name).toBe(`${name} nueva`);
        expect(saved.estimate).toBe(5);
        await expect(page.getByRole("button", { name: new RegExp(`^${name} nueva`) })).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("sheet, km, done task: a rename sends no estimate and the list shows the new name (RP-55)", async ({ person, browser, baseURL, db }) => {
      const { goalId, taskId, name } = await seed(db, person.id, "km", 5, { done: true });
      const { context, page, sheet } = await openSheet(browser, baseURL!, person.sessionFile, goalId, name);
      const posts = actions(page);
      try {
        await expect(sheet.getByLabel("Cuánto le calculas")).toHaveCount(0);
        await sheet.getByLabel("Nombre").fill(`${name} nueva`);
        await sheet.getByRole("button", { name: "Guardar" }).click();
        await expect(sheet).toBeHidden();
        const bodies = posts.map((request) => request.postData() ?? "");
        expect(bodies.some((body) => body.includes(`${name} nueva`))).toBe(true);
        for (const body of bodies) expect(body).not.toContain("estimate");
        expect((await stored(db, taskId)).estimate).toBe(5);
        await expect(page.getByRole("button", { name: new RegExp(`^${name} nueva`) })).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("sheet, minutes: «Cuánto le calculas» with hours and minutes, and a new figure is saved (RP-65)", async ({ person, browser, baseURL, db }) => {
      const { goalId, taskId, name } = await seed(db, person.id, "minutos", 90);
      const { context, sheet } = await openSheet(browser, baseURL!, person.sessionFile, goalId, name);
      try {
        await expect(sheet.getByLabel("Cuánto le calculas")).toHaveValue("1");
        await expect(sheet.getByRole("spinbutton", { name: "min" })).toHaveValue("30");
        await sheet.getByLabel("Cuánto le calculas").fill("2");
        await sheet.getByRole("spinbutton", { name: "min" }).fill("15");
        await sheet.getByRole("button", { name: "Guardar" }).click();
        await expect(sheet).toBeHidden();
        expect((await stored(db, taskId)).estimate).toBe(135);
      } finally {
        await context.close();
      }
    });

    test("sheet, km: «Guardar» is disabled and busy while the save is in flight (RP-65)", async ({ person, browser, baseURL, db }) => {
      const { goalId, name } = await seed(db, person.id, "km", null);
      const { context, page, sheet } = await openSheet(browser, baseURL!, person.sessionFile, goalId, name);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (request.method() === "POST" && request.headers()["next-action"] !== undefined) {
          await held;
          await route.continue();
        } else await route.continue();
      });
      try {
        await sheet.getByLabel("Nombre").fill(`${name} nueva`);
        const save = sheet.getByRole("button", { name: "Guardar" });
        await save.click();
        await expect(save).toBeDisabled();
        await expect(save).toHaveAttribute("aria-busy", "true");
        await expect(sheet.getByRole("button", { name: "Cancelar" })).toBeDisabled();
        release();
        await expect(sheet).toBeHidden();
      } finally {
        release();
        await context.close();
      }
    });

    test("sheet, km: a month change on a task with a day is refused under the month chips and the sheet stays open (RP-65)", async ({ person, browser, baseURL, db }) => {
      const { goalId, taskId, name } = await seed(db, person.id, "km", null, { day: true });
      const { context, sheet } = await openSheet(browser, baseURL!, person.sessionFile, goalId, name);
      try {
        await sheet.getByRole("radio", { name: label(last), exact: true }).click();
        await sheet.getByRole("button", { name: "Guardar" }).click();
        await expect(sheet.getByRole("radiogroup").getByRole("alert")).toContainText("Esa tarea tiene día");
        await expect(sheet).toBeVisible();
        expect((await stored(db, taskId)).planned_month).toBe(thisMonth);
      } finally {
        await context.close();
      }
    });

    test("sheet, km: Escape and «Cancelar» close it and send nothing (RP-65)", async ({ person, browser, baseURL, db }) => {
      const { goalId, taskId, name } = await seed(db, person.id, "km", 5);
      const { context, page, sheet } = await openSheet(browser, baseURL!, person.sessionFile, goalId, name);
      const posts = actions(page);
      try {
        await sheet.getByLabel("Nombre").fill(`${name} descartada`);
        await page.keyboard.press("Escape");
        await expect(sheet).toBeHidden();

        await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
        await expect(sheet.getByLabel("Nombre")).toHaveValue(name);
        await sheet.getByLabel("Nombre").fill(`${name} descartada`);
        await sheet.getByRole("button", { name: "Cancelar" }).click();
        await expect(sheet).toBeHidden();

        expect(posts).toHaveLength(0);
        expect((await stored(db, taskId)).name).toBe(name);
      } finally {
        await context.close();
      }
    });

    for (const unit of ["km", "paginas"] as const) {
      test(`form, ${unit}: the name alone, no «cuánto», and the button creates the task with no figure (RP-65)`, async ({ person, browser, baseURL, db }) => {
        const { goalId, goalName } = await seed(db, person.id, unit, 5);
        const { context, page } = await visit(browser, baseURL!, person.sessionFile, `/metas/${goalId}/meses/${seg(thisMonth)}/tarea/nueva`);
        const posts = actions(page);
        try {
          await expect(page.getByRole("heading", { name: `Una tarea de ${label(thisMonth)}` })).toBeVisible();
          await expect(page.getByText(`${goalName} · ${label(thisMonth)}`)).toBeVisible();
          await expect(page.getByLabel("qué hay que hacer")).toBeVisible();
          await expect(page.getByText(/cuánto, en/)).toHaveCount(0);
          await expect(page.getByRole("spinbutton")).toHaveCount(0);
          await expect(page.getByLabel("horas")).toHaveCount(0);
          await expect(page.getByLabel("minutos")).toHaveCount(0);
          await expect(page.getByRole("checkbox", { name: "con sub-tareas" })).toBeVisible();
          await expect(page.getByText(NO_MEASURE_CHILDREN)).toBeVisible();
          await expect(page.getByText(TIME_CHILDREN)).toHaveCount(0);

          const name = `Tarea sin cifra ${Date.now()}`;
          await page.getByLabel("qué hay que hacer").fill(name);
          await page.getByRole("button", { name: "Guardar la tarea" }).click();
          await expect(page).toHaveURL(new RegExp(`/metas/${goalId}/meses/${seg(thisMonth)}$`));
          const [created] = await db<{ estimate: number | null; planned_month: string | null }[]>`
            select estimate, to_char(planned_month, 'YYYY-MM-DD') as planned_month from goals.one_offs where goal_id = ${goalId} and name = ${name}
          `;
          expect(created.estimate).toBeNull();
          expect(created.planned_month).toBe(thisMonth);
          for (const request of posts) expect(request.postData() ?? "").not.toMatch(/"estimate":\s*\d/);
          await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
        } finally {
          await context.close();
        }
      });
    }

    test("form, minutes: hours and minutes as today, and the figure is saved (RP-65)", async ({ person, browser, baseURL, db }) => {
      const { goalId } = await seed(db, person.id, "minutos", 60);
      const { context, page } = await visit(browser, baseURL!, person.sessionFile, `/metas/${goalId}/meses/${seg(thisMonth)}/tarea/nueva`);
      try {
        await expect(page.getByLabel("horas")).toBeVisible();
        await expect(page.getByLabel("minutos")).toBeVisible();
        await expect(page.getByText(TIME_CHILDREN)).toBeVisible();
        await expect(page.getByText(NO_MEASURE_CHILDREN)).toHaveCount(0);
        const name = `Tarea con cifra ${Date.now()}`;
        await page.getByLabel("qué hay que hacer").fill(name);
        await page.getByLabel("horas").fill("1");
        await page.getByLabel("minutos").fill("20");
        await page.getByRole("button", { name: "Guardar la tarea" }).click();
        await expect(page).toHaveURL(new RegExp(`/metas/${goalId}/meses/${seg(thisMonth)}$`));
        const [created] = await db<{ estimate: number | null }[]>`select estimate from goals.one_offs where goal_id = ${goalId} and name = ${name}`;
        expect(created.estimate).toBe(80);
      } finally {
        await context.close();
      }
    });
  });
}

test("at 390 a km goal's open sheet does not overflow horizontally (RP-65)", async ({ person, browser, baseURL, db }) => {
  const { goalId, name } = await seed(db, person.id, "km", 5);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto(`/metas/${goalId}/meses/${seg(thisMonth)}`);
    await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByLabel("Nombre")).toBeVisible();
    await sheet.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)));
    const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(scroll).toBe(client);
    // The sheet may clip its own overflow, leaving the page's width untouched.
    const [sheetScroll, sheetClient] = await sheet.evaluate((el) => [el.scrollWidth, el.clientWidth]);
    expect(sheetScroll).toBe(sheetClient);
  } finally {
    await context.close();
  }
});
