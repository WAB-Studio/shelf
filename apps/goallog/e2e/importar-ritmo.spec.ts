import type { Browser, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import roadmap from "../messages/es/roadmap.json";
import { appAlerts, test, expect, settled as pageSettled } from "./fixtures";
import { todayInZone } from "../lib/zone";
import { movedExample, unfold } from "./importar-plan";
import { boxOf } from "./box";

// RP-63: the review says each goal's rhythm before the person confirms (board `ImportarRevisarRitmo`).
// RP-67: the row is «Ritmo al mes · las tareas van al plan» with an amount button (board `ImportarRitmoPlan`).
const RHYTHM_NAME = "Ritmo al mes";
const RHYTHM_LINE = "ritmo · las tareas van al plan";
const GOAL = "Evals y harness";
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
// months stay inside the goals' spans whatever day the suite runs.
function template(rhythm: string | null = "12 h"): string {
  // The example's closing «Leer» (no end, pages) is `importar-sin-final.spec.ts`'s: this file reads the rhythm in hours.
  const text = movedExample().split("\n\n# Leer\n")[0];
  if (!text.includes(SOURCE_LINE)) throw new Error("the template example carries no `ritmo:` line");
  return rhythm === null ? text.replace(`\n${SOURCE_LINE}`, "") : text.replace(SOURCE_LINE, `ritmo: ${rhythm}`);
}

function withKmGoal(): string {
  const horizon = `${shift(0).year + 1}-${shift(0).month}-01`;
  return `${template()}\n\n# Correr 10K\nhorizonte: ${horizon}\nmedida: distancia · km`;
}

async function toOpenReview(page: Page, text: string) {
  await page.goto("/metas/importar");
  await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
  await page.getByLabel(messages.textLabel).fill(text);
  await page.getByRole("button", { name: "Leer el plan" }).click();
  await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
  await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
  await pageSettled(page);
  await unfold(page);
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

const box = (page: Page, name: RegExp) => page.getByRole("checkbox", { name });
const rowOf = (page: Page, name: RegExp) => page.locator("div").filter({ has: page.getByRole("checkbox", { name }) }).last();
const monthLower = (by: number) => monthName(by).replace(/ \d+$/, "");
const wipe = (db: import("postgres").Sql, id: string) =>
  db`delete from goals.goals where user_id = ${id} and name in ('Carrera en IA', 'IA aplicada', 'Evals y harness', 'Correr 10K')`;

test.describe("the review says the rhythm before creating (RP-63, RP-35)", () => {
  for (const width of [390, 1440]) {
    test(`@${width}: the template's rhythm is a row «Ritmo al mes» with a «12 h» button and the board's line, under its goal`, async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, { width, height: 900 }, async (page) => {
        await toOpenReview(page, template());

        const main = page.getByText(RHYTHM_NAME, { exact: true });
        const meta = page.getByText(RHYTHM_LINE, { exact: true });
        await expect(main).toBeVisible();
        await expect(meta).toBeVisible();
        // The meta line sits under its main line, in the same row.
        const [mainBox, metaBox] = [(await boxOf(main)), (await boxOf(meta))];
        expect(metaBox.y).toBeGreaterThan(mainBox.y);
        expect(metaBox.y - mainBox.y).toBeLessThan(40);
        // And the row follows its goal's own row.
        const goal = (await boxOf(box(page, new RegExp(`^${GOAL} meta`))));
        expect(mainBox.y).toBeGreaterThan(goal.y);
        // Like the other rows of the board, it is a marked checkbox.
        await expect(rhythmBox(page)).toBeChecked();
        await expect(rhythmButton(page, "12 h")).toHaveText("12 h");
      });
    });
  }

  test("a rhythm with minutes reads in hours and minutes, not as 90 min or 1.5 h", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 900 }, async (page) => {
      await toOpenReview(page, template("1 h 30 min"));
      await expect(rhythmButton(page, "1 h 30 min")).toHaveText("1 h 30 min");
      await expect(page.getByText(RHYTHM_LINE, { exact: true })).toBeVisible();
      await expect(page.getByText(/90 min|1[.,]5 h/)).toHaveCount(0);
    });
  });

  test("a template without ritmo: paints no rhythm row, and no «0 h al mes»", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 900 }, async (page) => {
      await toOpenReview(page, template(null));
      await expect(box(page, /^IA aplicada/)).toBeVisible();
      await expect(page.getByText(RHYTHM_LINE, { exact: true })).toHaveCount(0);
      await expect(page.getByText(/ al mes$/)).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Cambiar el ritmo/ })).toHaveCount(0);
      await expect(page.getByText(/va al plan/)).toHaveCount(0);
      await expect(page.getByText(/^0 (h|min)/)).toHaveCount(0);
    });
  });

  test("a goal in km beside a timed one has no rhythm row: only the goal that carries it says it", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 1200 }, async (page) => {
      await toOpenReview(page, withKmGoal());
      await expect(page.getByRole("button", { name: "Crear 4 metas" })).toBeVisible();
      await expect(box(page, /^Correr 10K/)).toBeVisible();
      await expect(rowOf(page, /^Correr 10K/).getByText(RHYTHM_LINE, { exact: true })).toHaveCount(0);
      await expect(page.getByText(RHYTHM_LINE, { exact: true })).toHaveCount(1);
    });
  });

  test("confirming builds the plan: the goal opens with «El plan» and its end", async ({ person, browser, baseURL, db }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 900 }, async (page) => {
      try {
        await toOpenReview(page, template());
        await page.getByRole("button", { name: "Crear 3 metas" }).click();
        await expect(page).toHaveURL(/\/metas$/);
        await page.getByRole("link", { name: /Evals y harness/ }).first().click();
        await expect(page.getByText("El plan", { exact: true })).toBeVisible();
        const plan = page.getByRole("link", { name: /^A este ritmo terminas el .* Ritmo 12 h al mes/ });
        await expect(plan).toBeVisible();
        await expect(plan).toHaveAttribute("href", /\/metas\/[^/]+\/plan$/);
        const [goal] = await db`select rhythm from goals.goals where user_id = ${person.id} and name = ${GOAL}`;
        expect(goal.rhythm).toBe(720);
      } finally {
        await wipe(db, person.id);
      }
    });
  });

  test("unchecking the rhythm row creates the goal without a rhythm: the goal offers «Armar el plan»", async ({ person, browser, baseURL, db }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 900 }, async (page) => {
      try {
        await toOpenReview(page, template());
        const box = rhythmBox(page);
        await box.click();
        await expect(box).not.toBeChecked();
        await page.getByRole("button", { name: "Crear 3 metas" }).click();
        await expect(page).toHaveURL(/\/metas$/);
        await page.getByRole("link", { name: /Evals y harness/ }).first().click();
        await expect(page.getByRole("link", { name: "Armar el plan" })).toBeVisible();
        await expect(page.getByRole("link", { name: /A este ritmo terminas/ })).toHaveCount(0);
        const [goal] = await db`select rhythm from goals.goals where user_id = ${person.id} and name = ${GOAL}`;
        expect(goal.rhythm).toBeNull();
      } finally {
        await wipe(db, person.id);
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
        await toOpenReview(page, template());
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        await page.route("**/metas/importar/revisar", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          await gate;
          await route.continue();
        });
        await page.getByRole("button", { name: "Crear 3 metas" }).click();
        await expect(page.getByRole("button", { name: messages.review.creating })).toHaveAttribute("aria-busy", "true");
        release();
        await expect(page).toHaveURL(/\/metas$/);
        const goals = await db`select 1 from goals.goals where user_id = ${person.id} and name = ${GOAL}`;
        expect(goals).toHaveLength(1);
      } finally {
        await wipe(db, person.id);
      }
    });
  });

  test("«‹ tu texto» leads back with the template, ritmo: line included, still in the field", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 900 }, async (page) => {
      const text = template();
      await toOpenReview(page, text);
      await page.getByRole("link", { name: `Volver a ${messages.review.place}`, exact: true }).click();
      await expect(page).toHaveURL(/\/metas\/importar$/);
      await expect(page.getByLabel(messages.textLabel)).toHaveValue(text);
    });
  });

  test("at 360 the review with its rhythm row does not overflow, and every row keeps a 44px tap target", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, { width: 360, height: 800 }, async (page) => {
      await toOpenReview(page, withKmGoal());
      await expect(page.getByText(RHYTHM_LINE, { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const row = (await boxOf(rhythmBox(page).locator("xpath=ancestor::label")));
      expect(row.height).toBeGreaterThanOrEqual(44);
      expect(row.x + row.width).toBeLessThanOrEqual(360);
      const button = (await boxOf(rhythmButton(page, "12 h")));
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
          await toOpenReview(page, template().replace(`\n- ${shift(0).year}-${shift(0).month} · 12 h`, ""));
          await rhythmButton(page, "12 h").click();
          await expect(page.getByRole("heading", { name: "Cambiar el ritmo" })).toBeVisible();
          await expect(page.getByText("ritmo al mes · Evals y harness", { exact: true })).toBeVisible();
          await page.getByRole("spinbutton", { name: "horas" }).fill("10");
          await page.getByRole("spinbutton", { name: "minutos" }).fill("0");
          await page.getByRole("button", { name: "Guardar" }).click();
          await expect(page.getByRole("heading", { name: "Cambiar el ritmo" })).toHaveCount(0);
          await expect(rhythmButton(page, "10 h")).toHaveText("10 h");
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

          await page.getByRole("button", { name: "Crear 3 metas" }).click();
          await expect(page).toHaveURL(/\/metas$/);
          const [goal] = await db`select id, rhythm from goals.goals where user_id = ${person.id} and name = ${GOAL}`;
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
          await page.getByRole("link", { name: /Evals y harness/ }).first().click();
          // Imported today: the line still says the whole rhythm, never the share of this month.
          await expect(page.getByRole("link", { name: new RegExp(`^A este ritmo terminas el .* Ritmo 10 h al mes`) })).toBeVisible();
        } finally {
          await wipe(db, person.id);
        }
      });
    });
  }

  test("a change the person does not save: «Cancelar» closes the sheet and leaves «12 h»", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 900 }, async (page) => {
      await toOpenReview(page, template());
      await rhythmButton(page, "12 h").click();
      await page.getByRole("spinbutton", { name: "horas" }).fill("3");
      await page.getByRole("button", { name: "Cancelar" }).click();
      await expect(page.getByRole("heading", { name: "Cambiar el ritmo" })).toHaveCount(0);
      await expect(rhythmButton(page, "12 h")).toHaveText("12 h");
    });
  });

  test("0 h is refused with the rhythm's own reason under the field, the sheet stays open, nothing changes", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 900 }, async (page) => {
      await toOpenReview(page, template());
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
    test(`@${width}: with ritmo each task row says «tarea» and its month; a parent adds its sub-tasks' sum; none says «va al plan»`, async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, { width, height: 1200 }, async (page) => {
        await toOpenReview(page, template());
        const row = (task: RegExp) => rowOf(page, task).locator("label");
        for (const task of [/^Leer AI Engineering cap. 1–4/, /^Tutor/]) {
          await expect(row(task)).toContainText(`tarea · ${monthLower(0)}`);
        }
        await expect(row(/^Tutor/)).toContainText("7 h");
        await expect(page.getByText(/va al plan/)).toHaveCount(0);
        await expect(page.getByText(/la suma de lo marcado/)).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      });
    });
  }

  test("without ritmo there is no rhythm row, and the task rows say the same", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 1200 }, async (page) => {
      await toOpenReview(page, template(null));
      await expect(page.getByText(RHYTHM_NAME, { exact: true })).toHaveCount(0);
      await expect(rowOf(page, /^Leer AI Engineering/).locator("label")).toContainText(`tarea · ${monthLower(0)}`);
    });
  });

  test("unchecking the rhythm leaves the task rows as they were: each says its month, none says «va al plan»", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, { width: 390, height: 1200 }, async (page) => {
      await toOpenReview(page, template());
      await rhythmBox(page).click();
      await expect(rhythmBox(page)).not.toBeChecked();
      await expect(rowOf(page, /^Leer AI Engineering/).locator("label")).toContainText(`tarea · ${monthLower(0)}`);
      await expect(page.getByText(/va al plan/)).toHaveCount(0);
    });
  });
});
