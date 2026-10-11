import type { Browser, Locator, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { test, expect, visit } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "../lib/zone";

// The review's create bar says what the import leaves out, above «Crear N
// meta(s)» (RP-37). The board is `ImportarFuera`; its words are the ones
// written in docs/pulsar/DESIGN.md, not the ones the screen happens to carry.

const plus = (days: number) => {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
};
const month = todayInZone().slice(0, 7);

// A task with sub-tasks and its own amount: RP-37 leaves it out whole.
const parentWithAmount = (name: string, child = "Revisar") =>
  [`- ${month} · 4 h · ${name}`, `  - 1 h · ${child}`].join("\n");

const goal = (title: string, o: { horizon?: string; tasks?: string[] } = {}) =>
  [
    `# ${title}`,
    `horizonte: ${o.horizon ?? plus(200)}`,
    "medida: horas de estudio · minutos",
    "",
    "## Meses",
    `- ${month} · 12 h`,
    ...(o.tasks?.length ? ["", "## Tareas", ...o.tasks] : []),
  ].join("\n");

const plan = (...goals: string[]) => ["pulsar · plantilla 1", "", goals.join("\n\n")].join("\n");

type Fixtures = { person: { id: string; sessionFile: string }; browser: Browser; baseURL: string | undefined };

async function review(
  { person, browser, baseURL }: Fixtures,
  text: string,
  run: (page: Page, bar: Locator) => Promise<void>,
  viewport = { width: 390, height: 844 },
) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport });
  try {
    const page = await context.newPage();
    await page.goto("/metas/importar");
    await page.getByLabel(messages.textLabel).fill(text);
    await page.getByRole("button", { name: "Leer el plan" }).click();
    await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
    await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
    // The bar is the confirm button's own container.
    const bar = page.getByRole("button", { name: /^Crear \d+ metas?$/ }).locator("xpath=..");
    await run(page, bar);
  } finally {
    await context.close();
  }
}

const OUT = "Elegir método";
const lineOf = (bar: Locator) => bar.getByText(/^Sin .*no se pued/);

test.describe("the create bar says what stays out (RP-37)", () => {
  test("one item out: the board's line sits in the bar above «Crear 1 meta»", async ({ person, browser, baseURL }) => {
    await review({ person, browser, baseURL }, plan(goal("Con una fuera", { tasks: [parentWithAmount(OUT)] })), async (page, bar) => {
      await expect(bar).toContainText(`Sin «${OUT}» y su sub-tarea: no se puede crear.`);
      await expect(lineOf(bar)).toBeVisible();
      const line = (await lineOf(bar).boundingBox())!;
      const button = (await page.getByRole("button", { name: "Crear 1 meta" }).boundingBox())!;
      expect(line.y + line.height).toBeLessThanOrEqual(button.y + 1);
    });
  });

  test("several out: the line counts what the «No se puede crear» list shows, a goal refused whole once", async ({ person, browser, baseURL }) => {
    // Kept goal: two refused tasks. Goal past its horizon: refused whole, with two more refusals under it.
    const text = plan(
      goal("Meta viva", { tasks: [parentWithAmount("Primera"), parentWithAmount("Segunda")] }),
      goal("Meta vieja", { horizon: plus(-5), tasks: [parentWithAmount("Tercera"), parentWithAmount("Cuarta")] }),
    );
    await review({ person, browser, baseURL }, text, async (page, bar) => {
      await expect(bar).toContainText("Sin 3 cosas que no se pueden crear.");
      // The list and the line agree: three rows.
      const list = page.getByRole("heading", { name: messages.review.blocked.title }).locator("xpath=..");
      await expect(list).toContainText("Primera");
      await expect(list).toContainText("Segunda");
      await expect(list).toContainText("Meta vieja");
      await expect(list).not.toContainText("Cuarta");
    });
  });

  test("a goal refused whole: its name is in the line, once", async ({ person, browser, baseURL }) => {
    const text = plan(
      goal("Meta viva"),
      goal("Meta vieja", { horizon: plus(-5), tasks: [parentWithAmount("Hija uno"), parentWithAmount("Hija dos")] }),
    );
    await review({ person, browser, baseURL }, text, async (page, bar) => {
      const line = lineOf(bar);
      await expect(line).toHaveCount(1);
      await expect(line).toContainText("Meta vieja");
      await expect(line).not.toContainText("Hija");
      await expect(line).not.toContainText(/\d+ cosas/);
      await expect(page.getByRole("button", { name: "Crear 1 meta" })).toBeVisible();
    });
  });

  test("nothing out: the bar is the button alone", async ({ person, browser, baseURL }) => {
    await review({ person, browser, baseURL }, plan(goal("Limpia")), async (_page, bar) => {
      await expect(bar).toHaveText("Crear 1 meta");
      await expect(bar.locator("p")).toHaveCount(0);
      await expect(bar).not.toContainText("Sin ");
    });
  });

  test("the count links up to «No se puede crear»", async ({ person, browser, baseURL }) => {
    const tasks = [
      ...["Uno", "Dos", "Tres"].map((name) => parentWithAmount(name)),
      // Enough kept rows that the page scrolls past the list's heading.
      ...Array.from({ length: 14 }, (_, i) => `- ${month} · 1 h · Libre ${i + 1}`),
    ];
    await review({ person, browser, baseURL }, plan(goal("Con tres fuera", { tasks })), async (page, bar) => {
      const heading = page.getByRole("heading", { name: messages.review.blocked.title });
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await expect(heading).not.toBeInViewport();
      await expect(bar.getByRole("link", { name: /3/ })).toBeVisible();
      await bar.getByRole("link", { name: /3/ }).click();
      await expect(heading).toBeInViewport();
    });
  });

  test("«Crear 1 meta» still creates the goal without the refused task", async ({ person, browser, baseURL, db }) => {
    await review({ person, browser, baseURL }, plan(goal("Se crea sin ella", { tasks: [parentWithAmount(OUT)] })), async (page) => {
      await page.getByRole("button", { name: "Crear 1 meta" }).click();
      await expect(page).toHaveURL(/\/metas$/);
      const goals = await db`select id from goals.goals where user_id = ${person.id} and name = 'Se crea sin ella'`;
      expect(goals).toHaveLength(1);
      const named = await db`select id from goals.one_offs where user_id = ${person.id} and name in (${OUT}, 'Revisar')`;
      expect(named).toHaveLength(0);
    });
  });

  test("at 1440 with one goal the line stands inside the bar, one card wide", async ({ person, browser, baseURL }) => {
    await review(
      { person, browser, baseURL },
      plan(goal("Una sola", { tasks: [parentWithAmount(OUT)] })),
      async (page, bar) => {
        const card = (await page.getByRole("region", { name: "Una sola" }).boundingBox())!;
        const box = (await bar.boundingBox())!;
        await expect(lineOf(bar)).toBeVisible();
        const line = (await lineOf(bar).boundingBox())!;
        expect(Math.abs(card.width - box.width)).toBeLessThanOrEqual(1);
        expect(line.x).toBeGreaterThanOrEqual(box.x - 1);
        expect(line.x + line.width).toBeLessThanOrEqual(box.x + box.width + 1);
        expect(line.y).toBeGreaterThanOrEqual(box.y - 1);
        expect(line.y + line.height).toBeLessThanOrEqual(box.y + box.height + 1);
      },
      { width: 1440, height: 900 },
    );
  });
  test("two out: the line counts them, «Sin 2 cosas», and names neither", async ({ person, browser, baseURL }) => {
    const text = plan(goal("Con dos fuera", { tasks: [parentWithAmount("Primera"), parentWithAmount("Segunda")] }));
    await review({ person, browser, baseURL }, text, async (_page, bar) => {
      await expect(bar).toContainText("Sin 2 cosas que no se pueden crear.");
      await expect(lineOf(bar)).not.toContainText("Primera");
    });
  });

  test("a task refused with two sub-tasks: the line says «y sus 2 sub-tareas»", async ({ person, browser, baseURL }) => {
    const parent = [`- ${month} · 4 h · ${OUT}`, "  - 1 h · Uno", "  - 1 h · Dos"].join("\n");
    await review({ person, browser, baseURL }, plan(goal("Con dos hijas", { tasks: [parent] })), async (_page, bar) => {
      await expect(bar).toContainText(`Sin «${OUT}» y sus 2 sub-tareas: no se puede crear.`);
    });
  });

  test("a phase refused alone: the line names the phase, not the goal", async ({ person, browser, baseURL }) => {
    const text = plan(
      [
        "# Meta de la fase",
        `horizonte: ${plus(200)}`,
        "medida: horas de estudio · minutos",
        "",
        "## Fases",
        `- ${plus(150)} a ${plus(260)} · Fase larga`,
        "",
        "## Meses",
        `- ${month} · 12 h`,
      ].join("\n"),
    );
    await review({ person, browser, baseURL }, text, async (_page, bar) => {
      await expect(lineOf(bar)).toHaveText("Sin «Fase larga»: no se puede crear.");
    });
  });

  test("a month refused alone: the line names the month, not the goal", async ({ person, browser, baseURL }) => {
    const text = plan(
      [
        "# Meta del mes",
        `horizonte: ${plus(200)}`,
        "medida: horas de estudio · minutos",
        "",
        "## Meses",
        `- ${month} · 12 h`,
        "- 2020-03 · 5 h",
      ].join("\n"),
    );
    await review({ person, browser, baseURL }, text, async (_page, bar) => {
      await expect(lineOf(bar)).toHaveText("Sin «marzo 2020»: no se puede crear.");
    });
  });

  // The template refuses a quantity on a goal with no measure at its own line, so only
  // a model's draft, kept in the tab, reaches the review with one.
  test("a commitment refused alone: the line names the commitment, not the goal", async ({ person, browser, baseURL }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      await page.goto("/metas/importar");
      const stored = {
        via: "model",
        source: null,
        sourceName: null,
        unmarked: null,
        draft: {
          goals: [
            {
              name: "Meta del compromiso",
              horizon: plus(200),
              measure: null,
              phases: [],
              months: [],
              tasks: [],
              commitments: [
                {
                  name: "Correr lejos",
                  cadenceKind: "daily",
                  cadenceWeekdays: null,
                  cadenceN: null,
                  satisfaction: "quantity",
                  targetQuantity: 5,
                  unit: "km",
                },
              ],
            },
          ],
        },
      };
      await page.evaluate((value) => sessionStorage.setItem("pulsar.import-draft", JSON.stringify(value)), stored);
      await visit(page, "/metas/importar/revisar");
      const bar = page.getByRole("button", { name: /^Crear \d+ metas?$/ }).locator("xpath=..");
      await expect(lineOf(bar)).toHaveText("Sin «Correr lejos»: no se puede crear.");
    } finally {
      await context.close();
    }
  });
});
