import { test, expect } from "./fixtures";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// RP-50, `MetaSinPlanTareas`: the sheet of a task whose goal does not measure
// time asks for a month and nothing else about the plan. A goal that measures
// time keeps «Lo pone el plan» / «Fijarla en». Calendar-bound: «this month» is
// the current one and the goal runs three months past it.

const NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const label = (month: string) => NAMES[Number(month.slice(5, 7)) - 1];

const thisMonth = monthOf(todayInZone());
const later = nextMonth(thisMonth);
const last = nextMonth(later);
const horizon = nextMonth(last);
const seg = (month: string) => month.slice(0, 7);

const SENTENCE = "Se queda en el mes que elijas. Esta meta no mide tiempo, así que ningún plan la mueve.";
const PIN_HINT = "Una tarea fijada no se mueve con el plan. Las demás se acomodan alrededor.";

type Db = import("postgres").Sql;

async function seed(db: Db, personId: string, unit: "km" | "minutos" | null, plannedMonth: string | null = thisMonth) {
  const stamp = Date.now();
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${`Correr 10K ${stamp}`}, ${horizon}::date, ${unit}, ${unit}, now() - interval '3 days')
    returning id
  `;
  const name = `Comprar zapatillas ${stamp}`;
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, estimate, planned_month, in_plan)
    values (${personId}, ${goal.id}, ${name}, ${unit === "minutos" ? 60 : null}, ${plannedMonth}::date, ${plannedMonth !== null})
    returning id
  `;
  return { goalId: goal.id, goalName: `Correr 10K ${stamp}`, taskId: task.id, name };
}

for (const width of [390, 1440]) {
  test.describe(`at ${width}`, () => {
    async function open(browser: import("@playwright/test").Browser, baseURL: string, sessionFile: string, goalId: string, name: string) {
      const context = await browser.newContext({ storageState: sessionFile, baseURL, viewport: { width, height: 900 } });
      const page = await context.newPage();
      await page.goto(`/metas/${goalId}/meses/${seg(thisMonth)}`);
      await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
      const sheet = page.getByRole("dialog", { name });
      await expect(sheet).toBeVisible();
      return { context, page, sheet };
    }

    test("a km goal's sheet has no plan radios and shows a chip per month of the goal at once", async ({ person, browser, baseURL, db }) => {
      const { goalId, goalName, name } = await seed(db, person.id, "km");
      const { context, sheet } = await open(browser, baseURL!, person.sessionFile, goalId, name);
      try {
        await expect(sheet).toContainText(`tarea · ${goalName}`);
        await expect(sheet.getByText("Mes", { exact: true })).toBeVisible();
        for (const month of [thisMonth, later, last]) {
          await expect(sheet.getByRole("radio", { name: label(month), exact: true })).toBeVisible();
        }
        await expect(sheet.getByRole("radio", { name: label(thisMonth), exact: true })).toHaveAttribute("aria-checked", "true");
        await expect(sheet.getByRole("radio", { name: label(later), exact: true })).toHaveAttribute("aria-checked", "false");
        await expect(sheet.getByText("Lo pone el plan")).toHaveCount(0);
        await expect(sheet.getByText("Fijarla en")).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("a km goal's sheet says the sentence once and never the pin hint", async ({ person, browser, baseURL, db }) => {
      const { goalId, name } = await seed(db, person.id, "km");
      const { context, page, sheet } = await open(browser, baseURL!, person.sessionFile, goalId, name);
      try {
        await expect(page.getByText(SENTENCE, { exact: true })).toHaveCount(1);
        await expect(sheet).toContainText(SENTENCE);
        await expect(sheet).not.toContainText(PIN_HINT);
      } finally {
        await context.close();
      }
    });

    test("choosing the later month and saving moves the task to that month's list as a pinned month, not into the plan", async ({ person, browser, baseURL, db }) => {
      const { goalId, taskId, name } = await seed(db, person.id, "km");
      const { context, page, sheet } = await open(browser, baseURL!, person.sessionFile, goalId, name);
      try {
        await sheet.getByRole("radio", { name: label(later), exact: true }).click();
        await expect(sheet.getByRole("radio", { name: label(later), exact: true })).toHaveAttribute("aria-checked", "true");
        await sheet.getByRole("button", { name: "Guardar" }).click();
        await expect(sheet).toBeHidden();
        const [saved] = await db<{ planned_month: string | null }[]>`
          select to_char(planned_month, 'YYYY-MM-DD') as planned_month from goals.one_offs where id = ${taskId}
        `;
        expect(saved.planned_month).toBe(later);
        await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toHaveCount(0);
        await page.goto(`/metas/${goalId}/meses/${seg(later)}`);
        await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("a goal that measures time keeps «Lo pone el plan», «Fijarla en» and the pin hint", async ({ person, browser, baseURL, db }) => {
      const { goalId, name } = await seed(db, person.id, "minutos");
      const { context, sheet } = await open(browser, baseURL!, person.sessionFile, goalId, name);
      try {
        await expect(sheet.getByRole("radio", { name: /^Lo pone el plan/ })).toBeVisible();
        await expect(sheet.getByRole("radio", { name: "Fijarla en" })).toBeVisible();
        await expect(sheet).toContainText(PIN_HINT);
        await expect(sheet).not.toContainText(SENTENCE);
      } finally {
        await context.close();
      }
    });
  });
}

test("at 390 a km goal's open sheet does not overflow horizontally", async ({ person, browser, baseURL, db }) => {
  const { goalId, name } = await seed(db, person.id, "km");
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`/metas/${goalId}/meses/${seg(thisMonth)}`);
    await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
    const sheet = page.getByRole("dialog", { name });
    await expect(sheet.getByRole("radio", { name: label(last), exact: true })).toBeVisible();
    await sheet.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)));
    const [page_, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(page_).toBeLessThanOrEqual(inner);
    const box = await sheet.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  } finally {
    await context.close();
  }
});

for (const width of [390, 1440]) {
  test(`at ${width} creating from «Añadir una tarea» on a goal that measures nothing stores the chosen month as planned_month`, async ({ person, browser, baseURL, db }) => {
    const { goalId } = await seed(db, person.id, null);
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
    const page = await context.newPage();
    try {
      await page.goto(`/metas/${goalId}/plan`);
      await page.getByRole("button", { name: "Añadir una tarea" }).click();
      const sheet = page.getByRole("dialog");
      await expect(sheet.getByRole("heading", { name: "Una tarea nueva" })).toBeVisible();
      await expect(sheet.getByText("Lo pone el plan")).toHaveCount(0);
      await expect(sheet.getByRole("radio", { name: label(thisMonth), exact: true })).toHaveAttribute("aria-checked", "true");
      await sheet.getByLabel("Nombre").fill("Creada en el mes elegido");
      await sheet.getByRole("radio", { name: label(later), exact: true }).click();
      await sheet.getByRole("button", { name: "Guardar" }).click();
      await expect(sheet).toBeHidden();
      const [saved] = await db<{ planned_month: string | null; in_plan: boolean }[]>`
        select to_char(planned_month, 'YYYY-MM-DD') as planned_month, in_plan
        from goals.one_offs where goal_id = ${goalId} and name = 'Creada en el mes elegido'
      `;
      // The table forces in_plan on any row that holds a month, so the month is the proof.
      expect(saved.planned_month).toBe(later);
    } finally {
      await context.close();
    }
  });

  test(`at ${width} a goal that measures nothing shows the month chips and the sentence, with no radio of the plan`, async ({ person, browser, baseURL, db }) => {
    const { goalId } = await seed(db, person.id, null);
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
    const page = await context.newPage();
    try {
      await page.goto(`/metas/${goalId}/plan`);
      await page.getByRole("button", { name: "Añadir una tarea" }).click();
      const sheet = page.getByRole("dialog");
      await expect(sheet.getByText("Mes", { exact: true })).toBeVisible();
      await expect(sheet.getByRole("radio", { name: label(thisMonth), exact: true })).toBeVisible();
      await expect(sheet.getByText("Lo pone el plan")).toHaveCount(0);
      await expect(sheet.getByText("Fijarla en")).toHaveCount(0);
      await expect(sheet).toContainText(SENTENCE);
      await expect(sheet).not.toContainText(PIN_HINT);
    } finally {
      await context.close();
    }
  });
}

// DESIGN.md "scrim, never a blur": the overlay paints no ground of its own, so the page behind shows
// through the scrim that its `::before` carries.
const SCRIM = { light: "rgba(18, 23, 28, 0.34)", dark: "rgba(5, 7, 9, 0.62)" };

for (const scheme of ["light", "dark"] as const) {
  test(`at 360 on ${scheme} the open sheet's overlay is transparent and only its ::before dims the page`, async ({ person, browser, baseURL, db }) => {
    const { goalId, name } = await seed(db, person.id, "km");
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width: 360, height: 800 },
      colorScheme: scheme,
    });
    const page = await context.newPage();
    try {
      await page.goto(`/metas/${goalId}/meses/${seg(thisMonth)}`);
      const behind = page.getByRole("button", { name: new RegExp(`^${name}`) });
      await behind.click();
      const sheet = page.getByRole("dialog", { name });
      await expect(sheet).toBeVisible();
      await sheet.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)));
      const paint = await page.evaluate(() => {
        const overlay = document.querySelector(".rt-BaseDialogOverlay")!;
        const dialog = document.querySelector('[role="dialog"]')!;
        return {
          overlay: getComputedStyle(overlay).backgroundColor,
          scrim: getComputedStyle(overlay, "::before").backgroundColor,
          panel: getComputedStyle(dialog).backgroundColor,
          root: getComputedStyle(document.querySelector(".radix-themes")!).backgroundColor,
        };
      });
      console.log(`paint ${scheme}`, JSON.stringify(paint));
      expect(paint.overlay).toBe("rgba(0, 0, 0, 0)");
      expect(paint.scrim).toBe(SCRIM[scheme]);
      expect(paint.panel).not.toBe("rgba(0, 0, 0, 0)");
      expect(paint.root).not.toBe("rgba(0, 0, 0, 0)");
      await expect(page.getByText(name).first()).toBeAttached();
    } finally {
      await context.close();
    }
  });
}
