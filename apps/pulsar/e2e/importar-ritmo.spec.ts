import type { Browser, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import roadmap from "../messages/es/roadmap.json";
import { appAlerts, test, expect, settled as pageSettled } from "./fixtures";
import { todayInZone } from "../lib/zone";

// RP-63: the review says each goal's rhythm before the person confirms (board `ImportarRevisarRitmo`).
// RP-67: the row is «Ritmo al mes · las tareas van al plan» with an amount button (board `ImportarRitmoPlan`).
const RHYTHM_NAME = "Ritmo al mes";
const RHYTHM_LINE = "las tareas van al plan";
const rhythmButton = (page: Page, amount: string) => page.getByRole("button", { name: `Cambiar el ritmo, ${amount} al mes`, exact: true });
const rhythmBox = (page: Page) => page.getByRole("checkbox", { name: new RegExp(RHYTHM_NAME) });
const monthName = (by: number) =>
  `${new Date(Date.UTC(shift(by).year, Number(shift(by).month) - 1, 1)).toLocaleDateString("es", { month: "long", timeZone: "UTC" })} ${shift(by).year}`;
const SOURCE_LINE = "ritmo: 12 h";

function shift(by: number) {
  const [year, month] = todayInZone().split("-").map(Number);
  const index = year * 12 + (month - 1) + by;
  return { year: Math.floor(index / 12), month: String((index % 12) + 1).padStart(2, "0") };
}

// The catalogue's own example, its dates moved to the person's now so the
// months stay inside the goal's span whatever day the suite runs.
function template(rhythm: string | null = "12 h"): string {
  const first = `${shift(0).year}-${shift(0).month}`;
  const second = `${shift(1).year}-${shift(1).month}`;
  const horizon = `${shift(0).year + 1}-${shift(0).month}-01`;
  const text = messages.template.example
    .replace("2027-10-01", horizon)
    .replace("2026-10-01 a 2026-12-31", `${first}-01 a ${first}-28`)
    .replaceAll("2026-10", first)
    .replaceAll("2026-11", second);
  if (!text.includes(SOURCE_LINE)) throw new Error("the template example carries no `ritmo:` line");
  return rhythm === null ? text.replace(`\n${SOURCE_LINE}`, "") : text.replace(SOURCE_LINE, `ritmo: ${rhythm}`);
}

function withKmGoal(): string {
  const horizon = `${shift(0).year + 1}-${shift(0).month}-01`;
  return `${template()}\n\n# Correr 10K\nhorizonte: ${horizon}\nmedida: distancia · km`;
}

async function toReview(page: Page, text: string) {
  await page.goto("/metas/importar");
  await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
  await page.getByLabel(messages.textLabel).fill(text);
  await page.getByRole("button", { name: "Leer el plan" }).click();
  await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
  await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
  await pageSettled(page);
}

type Fixtures = { person: { id: string; sessionFile: string }; browser: Browser; baseURL: string | undefined };
async function asPerson(
  { person, browser, baseURL }: Fixtures,
  viewport: { width: number; height: number },
  run: (page: Page) => Promise<void>,
) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport });
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

const goalCard = (page: Page, name: string) => page.getByRole("region", { name });

test.describe("the review says the rhythm before creating (RP-63, RP-35)", () => {
  for (const width of [390, 1440]) {
    test(`@${width}: the template's rhythm is a row «Ritmo al mes» with a «12 h» button and the board's line, after the measure row`, async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, { width, height: 900 }, async (page) => {
        await toReview(page, template());
        const card = goalCard(page, "IA aplicada");

        const main = card.getByText(RHYTHM_NAME, { exact: true });
        const meta = card.getByText(RHYTHM_LINE, { exact: true });
        await expect(main).toBeVisible();
        await expect(meta).toBeVisible();
        // The meta line sits under its main line, in the same row.
        const [mainBox, metaBox] = [(await main.boundingBox())!, (await meta.boundingBox())!];
        expect(metaBox.y).toBeGreaterThan(mainBox.y);
        expect(metaBox.y - mainBox.y).toBeLessThan(40);
        // And the row follows the measure row.
        const measure = (await card.getByText("horas de estudio", { exact: true }).boundingBox())!;
        expect(mainBox.y).toBeGreaterThan(measure.y);
        // Like the other rows of the board, it is a marked checkbox.
        await expect(rhythmBox(page)).toBeChecked();
        await expect(rhythmButton(page, "12 h")).toHaveText("12 h");
      });
    });
  }

  test("a rhythm with minutes reads in hours and minutes, not as 90 min or 1.5 h", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 900 }, async (page) => {
      await toReview(page, template("1 h 30 min"));
      const card = goalCard(page, "IA aplicada");
      await expect(rhythmButton(page, "1 h 30 min")).toHaveText("1 h 30 min");
      await expect(card.getByText(RHYTHM_LINE, { exact: true })).toBeVisible();
      await expect(card.getByText(/90 min|1[.,]5 h/)).toHaveCount(0);
    });
  });

  test("a template without ritmo: paints no rhythm row, and no «0 h al mes»", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 900 }, async (page) => {
      await toReview(page, template(null));
      await expect(goalCard(page, "IA aplicada")).toBeVisible();
      await expect(page.getByText(RHYTHM_LINE, { exact: true })).toHaveCount(0);
      await expect(page.getByText(/ al mes$/)).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Cambiar el ritmo/ })).toHaveCount(0);
      await expect(page.getByText(/va al plan/)).toHaveCount(0);
      await expect(page.getByText(/^0 (h|min)/)).toHaveCount(0);
    });
  });

  test("a goal in km beside a timed one has no rhythm row: only the goal that carries it says it", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 1200 }, async (page) => {
      await toReview(page, withKmGoal());
      await expect(page.getByRole("button", { name: "Crear 2 metas" })).toBeVisible();
      await expect(goalCard(page, "IA aplicada").getByText(RHYTHM_LINE, { exact: true })).toHaveCount(1);
      const km = goalCard(page, "Correr 10K");
      await expect(km.getByText("distancia", { exact: true })).toBeVisible();
      await expect(km.getByText(RHYTHM_LINE, { exact: true })).toHaveCount(0);
      await expect(page.getByText(RHYTHM_LINE, { exact: true })).toHaveCount(1);
    });
  });

  test("confirming builds the plan: the goal opens with «El plan» and its end", async ({ person, browser, baseURL, db }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 900 }, async (page) => {
      try {
        await toReview(page, template());
        await page.getByRole("button", { name: "Crear 1 meta" }).click();
        await expect(page).toHaveURL(/\/metas$/);
        await page.getByRole("link", { name: /IA aplicada/ }).first().click();
        await expect(page.getByText("el plan", { exact: true })).toBeVisible();
        const plan = page.getByRole("link", { name: /^A este ritmo terminas el .* Ritmo 12 h al mes/ });
        await expect(plan).toBeVisible();
        await expect(plan).toHaveAttribute("href", /\/metas\/[^/]+\/plan$/);
        const [goal] = await db`select rhythm from goals.goals where user_id = ${person.id} and name = 'IA aplicada'`;
        expect(goal.rhythm).toBe(720);
      } finally {
        await db`delete from goals.goals where user_id = ${person.id} and name in ('IA aplicada', 'Correr 10K')`;
      }
    });
  });

  test("unchecking the rhythm row creates the goal without a rhythm: the goal offers «Armar el plan»", async ({ person, browser, baseURL, db }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 900 }, async (page) => {
      try {
        await toReview(page, template());
        const box = rhythmBox(page);
        await box.click();
        await expect(box).not.toBeChecked();
        await page.getByRole("button", { name: "Crear 1 meta" }).click();
        await expect(page).toHaveURL(/\/metas$/);
        await page.getByRole("link", { name: /IA aplicada/ }).first().click();
        await expect(page.getByRole("link", { name: "Armar el plan" })).toBeVisible();
        await expect(page.getByRole("link", { name: /A este ritmo terminas/ })).toHaveCount(0);
        const [goal] = await db`select rhythm from goals.goals where user_id = ${person.id} and name = 'IA aplicada'`;
        expect(goal.rhythm).toBeNull();
      } finally {
        await db`delete from goals.goals where user_id = ${person.id} and name = 'IA aplicada'`;
      }
    });
  });

  test("ritmo: on a goal measured in km is refused with its line, and nothing is written", async ({ person, browser, baseURL, db }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 900 }, async (page) => {
      const text = template().replace("medida: horas de estudio · minutos", "medida: distancia · km").replace(SOURCE_LINE, "ritmo: 10 h");
      await page.goto("/metas/importar");
      await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
      await page.getByLabel(messages.textLabel).fill(text);
      await page.getByRole("button", { name: "Leer el plan" }).click();

      const line = text.split("\n").indexOf("ritmo: 10 h") + 1;
      await expect(appAlerts(page).filter({ hasText: /\S/ })).toContainText(`Línea ${line}: «ritmo: 10 h»`);
      await expect(page).toHaveURL(/\/metas\/importar$/);
      await expect(page.getByLabel(messages.textLabel)).toHaveValue(text);
      const goals = await db`select 1 from goals.goals where user_id = ${person.id}`;
      expect(goals).toHaveLength(0);
    });
  });

  test("while it confirms the button is aria-busy, and the goal is written once", async ({ person, browser, baseURL, db }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 900 }, async (page) => {
      try {
        await toReview(page, template());
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        await page.route("**/metas/importar/revisar", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          await gate;
          await route.continue();
        });
        await page.getByRole("button", { name: "Crear 1 meta" }).click();
        await expect(page.getByRole("button", { name: messages.review.creating })).toHaveAttribute("aria-busy", "true");
        release();
        await expect(page).toHaveURL(/\/metas$/);
        const goals = await db`select 1 from goals.goals where user_id = ${person.id} and name = 'IA aplicada'`;
        expect(goals).toHaveLength(1);
      } finally {
        await db`delete from goals.goals where user_id = ${person.id} and name = 'IA aplicada'`;
      }
    });
  });

  test("«‹ tu texto» leads back with the template, ritmo: line included, still in the field", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 900 }, async (page) => {
      const text = template();
      await toReview(page, text);
      await page.getByRole("link", { name: `Volver a ${messages.review.place}`, exact: true }).click();
      await expect(page).toHaveURL(/\/metas\/importar$/);
      await expect(page.getByLabel(messages.textLabel)).toHaveValue(text);
    });
  });

  test("at 360 the review with its rhythm row does not overflow, and every row keeps a 44px tap target", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, { width: 360, height: 800 }, async (page) => {
      await toReview(page, withKmGoal());
      await expect(page.getByText(RHYTHM_LINE, { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const row = (await rhythmBox(page).locator("xpath=ancestor::label").boundingBox())!;
      expect(row.height).toBeGreaterThanOrEqual(44);
      expect(row.x + row.width).toBeLessThanOrEqual(360);
      const button = (await rhythmButton(page, "12 h").boundingBox())!;
      expect(button.height).toBeGreaterThanOrEqual(44);
      expect(button.width).toBeGreaterThanOrEqual(44);
      expect(button.x + button.width).toBeLessThanOrEqual(360);
    });
  });
});

test.describe("the rhythm row is touched like an amount (RP-67)", () => {

  for (const width of [360, 1440]) {
    test(`@${width}: touching «12 h», writing 10 h and creating stores rhythm = 600 and puts the tasks in the plan`, async ({ person, browser, baseURL, db }) => {
      await asPerson({ person, browser, baseURL }, { width, height: 900 }, async (page) => {
        try {
          // The current month's own budget would beat the rhythm on the plan link (RP-50): drop it.
          await toReview(page, template().replace(`\n- ${shift(0).year}-${shift(0).month} · 12 h`, ""));
          await rhythmButton(page, "12 h").click();
          await expect(page.getByRole("heading", { name: "Cambiar el ritmo" })).toBeVisible();
          await expect(page.getByText("ritmo al mes · IA aplicada", { exact: true })).toBeVisible();
          await page.getByRole("spinbutton", { name: "horas" }).fill("10");
          await page.getByRole("spinbutton", { name: "minutos" }).fill("0");
          await page.getByRole("button", { name: "Guardar" }).click();
          await expect(page.getByRole("heading", { name: "Cambiar el ritmo" })).toHaveCount(0);
          await expect(rhythmButton(page, "10 h")).toHaveText("10 h");
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

          await page.getByRole("button", { name: "Crear 1 meta" }).click();
          await expect(page).toHaveURL(/\/metas$/);
          const [goal] = await db`select id, rhythm from goals.goals where user_id = ${person.id} and name = 'IA aplicada'`;
          expect(goal.rhythm).toBe(600);
          // The tasks are the plan's to place: in the plan, no fixed month.
          const tasks = await db`
            select name, in_plan, planned_month from goals.one_offs
            where goal_id = ${goal.id} and parent_id is null and name in ('Leer AI Engineering cap. 1–4', 'Tutor')`;
          expect(tasks).toHaveLength(2);
          for (const task of tasks) {
            expect(task.in_plan).toBe(true);
            expect(task.planned_month).toBeNull();
          }
          await page.getByRole("link", { name: /IA aplicada/ }).first().click();
          // Imported today: the line still says the whole rhythm, never the share of this month.
          await expect(page.getByRole("link", { name: new RegExp(`^A este ritmo terminas el .* Ritmo 10 h al mes`) })).toBeVisible();
        } finally {
          await db`delete from goals.goals where user_id = ${person.id} and name = 'IA aplicada'`;
        }
      });
    });
  }

  test("a change the person does not save: «Cancelar» closes the sheet and leaves «12 h»", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 900 }, async (page) => {
      await toReview(page, template());
      await rhythmButton(page, "12 h").click();
      await page.getByRole("spinbutton", { name: "horas" }).fill("3");
      await page.getByRole("button", { name: "Cancelar" }).click();
      await expect(page.getByRole("heading", { name: "Cambiar el ritmo" })).toHaveCount(0);
      await expect(rhythmButton(page, "12 h")).toHaveText("12 h");
    });
  });

  test("0 h is refused with the rhythm's own reason under the field, the sheet stays open, nothing changes", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 900 }, async (page) => {
      await toReview(page, template());
      await rhythmButton(page, "12 h").click();
      await page.getByRole("spinbutton", { name: "horas" }).fill("0");
      await page.getByRole("spinbutton", { name: "minutos" }).fill("0");
      await page.getByRole("button", { name: "Guardar" }).click();
      await expect(page.getByText(roadmap.errors.rhythmRange, { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Cambiar el ritmo" })).toBeVisible();
      await page.getByRole("button", { name: "Cancelar" }).click();
      await expect(rhythmButton(page, "12 h")).toHaveText("12 h");
    });
  });

  for (const width of [360, 1440]) {
    test(`@${width}: with ritmo each task row says «va al plan», no month; a parent adds «la suma de lo marcado», no month`, async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, { width, height: 1200 }, async (page) => {
        await toReview(page, template());
        const card = goalCard(page, "IA aplicada");
        const row = (task: string) => card.locator("label").filter({ hasText: task }).first();
        for (const task of ["Leer AI Engineering cap. 1–4", "Tutor"]) {
          await expect(row(task).getByText("va al plan", { exact: true })).toBeVisible();
          // The month only orders the plan: no row promises it.
          await expect(row(task).getByText(/desde|octubre|noviembre|diciembre|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre/i)).toHaveCount(0);
        }
        await expect(row("Tutor").getByText("la suma de lo marcado", { exact: true })).toBeVisible();
        await expect(row("Leer AI Engineering cap. 1–4").getByText("la suma de lo marcado")).toHaveCount(0);
        // The sentence is whole, not «<month> · la suma de lo marcado».
        await expect(card.getByText(new RegExp(`${monthName(0)} · la suma de lo marcado`))).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      });
    });
  }

  test("without ritmo the parent keeps «<month> · la suma de lo marcado» and the leaf its month", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 1200 }, async (page) => {
      await toReview(page, template(null));
      const card = goalCard(page, "IA aplicada");
      await expect(card.getByText(`${monthName(0)} · la suma de lo marcado`, { exact: true })).toBeVisible();
      await expect(card.locator("label").filter({ hasText: "Leer AI Engineering" }).first().getByText(monthName(0), { exact: true })).toBeVisible();
    });
  });

  test("unchecking the rhythm fixes the tasks to their month again: no «va al plan»", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 1200 }, async (page) => {
      await toReview(page, template());
      const card = goalCard(page, "IA aplicada");
      await rhythmBox(page).click();
      await expect(rhythmBox(page)).not.toBeChecked();
      await expect(card.locator("label").filter({ hasText: "Leer AI Engineering" }).first().getByText(monthName(0), { exact: true })).toBeVisible();
      await expect(card.getByText(/va al plan/)).toHaveCount(0);
    });
  });
});
