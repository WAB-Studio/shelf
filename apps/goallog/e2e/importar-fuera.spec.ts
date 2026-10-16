import type { Browser, Locator, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { test, expect } from "./fixtures";
import { rawGoal, seedOf, toOpenSeededReview, unfold } from "./importar-plan";
import { civilDateToDate, dateToCivilDate, todayInZone } from "../lib/zone";
import { boxOf } from "./box";

// What the import leaves out is listed under «No se puede crear», one row for a part and the
// parts it drags with it, and the bar holds the button alone (RP-37, RP-97). The boards are
// `ImportarFuera` and `ImportarArbol`; the words are the ones written in docs/goallog/DESIGN.md.

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
    await unfold(page);
    // The bar is the confirm button's own container.
    const bar = page.getByRole("button", { name: /^Crear \d+ metas?$/ }).locator("xpath=..");
    await run(page, bar);
  } finally {
    await context.close();
  }
}

const OUT = "Elegir método";
const blocked = (page: Page) => page.getByText(messages.review.blocked.title, { exact: true }).locator("xpath=..");

test.describe("what stays out is listed, and the bar is the button alone (RP-37, RP-97)", () => {
  test("one part out: it is listed under «No se puede crear» with its sub-tasks left out of the list, and the bar says nothing", async ({ person, browser, baseURL }) => {
    const parent = [`- ${month} · 4 h · ${OUT}`, "  - 1 h · Uno", "  - 1 h · Dos"].join("\n");
    await review({ person, browser, baseURL }, plan(goal("Con una fuera", { tasks: [parent] })), async (page, bar) => {
      const list = blocked(page);
      await expect(list).toContainText(OUT);
      await expect(list).not.toContainText("Uno");
      await expect(list).not.toContainText("Dos");
      await expect(page.getByRole("checkbox", { name: new RegExp(`^${OUT}`) }).first()).toBeDisabled();
      await expect(bar).toHaveText("Crear 1 meta");
      await expect(bar.locator("p")).toHaveCount(0);
      await expect(page.getByText(/^Sin .*no se pued/)).toHaveCount(0);
    });
  });

  test("a goal refused whole is listed once, and the parts under it are not", async ({ person, browser, baseURL }) => {
    const text = plan(
      goal("Meta viva", { tasks: [parentWithAmount("Primera"), parentWithAmount("Segunda")] }),
      goal("Meta vieja", { horizon: plus(-5), tasks: [parentWithAmount("Tercera"), parentWithAmount("Cuarta")] }),
    );
    await review({ person, browser, baseURL }, text, async (page, bar) => {
      const list = blocked(page);
      await expect(list).toContainText("Primera");
      await expect(list).toContainText("Segunda");
      await expect(list).toContainText("Meta vieja");
      await expect(list).not.toContainText("Tercera");
      await expect(list).not.toContainText("Cuarta");
      await expect(list.getByText("Meta vieja")).toHaveCount(1);
      await expect(bar).toHaveText("Crear 1 meta");
    });
  });

  test("nothing out: no list and the bar is the button alone", async ({ person, browser, baseURL }) => {
    await review({ person, browser, baseURL }, plan(goal("Limpia")), async (page, bar) => {
      await expect(bar).toHaveText("Crear 1 meta");
      await expect(bar.locator("p")).toHaveCount(0);
      await expect(page.getByText(messages.review.blocked.title, { exact: true })).toHaveCount(0);
    });
  });

  test("the list stands after the tree, so the count has nothing to link to", async ({ person, browser, baseURL }) => {
    const tasks = [
      ...["Uno", "Dos", "Tres"].map((name) => parentWithAmount(name)),
      ...Array.from({ length: 14 }, (_, i) => `- ${month} · 1 h · Libre ${i + 1}`),
    ];
    await review({ person, browser, baseURL }, plan(goal("Con tres fuera", { tasks })), async (page, bar) => {
      const title = page.getByText(messages.review.blocked.title, { exact: true });
      const last = (await boxOf(page.getByRole("checkbox", { name: /^Libre 14/ })));
      expect((await boxOf(title)).y).toBeGreaterThan(last.y);
      await expect(bar.getByRole("link")).toHaveCount(0);
      await expect(blocked(page)).toContainText("Uno");
      await expect(blocked(page)).toContainText("Tres");
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

  test("at 1440 the bar stands one card wide", async ({ person, browser, baseURL }) => {
    await review(
      { person, browser, baseURL },
      plan(goal("Una sola", { tasks: [parentWithAmount(OUT)] })),
      async (page, bar) => {
        const card = (await boxOf(page.getByRole("region", { name: messages.review.title })));
        const box = (await boxOf(bar));
        expect(Math.abs(card.width - box.width)).toBeLessThanOrEqual(1);
      },
      { width: 1440, height: 900 },
    );
  });

  test("a phase refused alone: the row names the phase and says its class, not the goal's", async ({ person, browser, baseURL }) => {
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
    await review({ person, browser, baseURL }, text, async (page, bar) => {
      const list = blocked(page);
      await expect(list).toContainText("Fase larga");
      await expect(list).toContainText("Meta de la fase · fase");
      await expect(list).not.toContainText("Meta de la fase · meta");
      await expect(bar).toHaveText("Crear 1 meta");
    });
  });

  test("a month refused alone: the row names the month with its year", async ({ person, browser, baseURL }) => {
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
    await review({ person, browser, baseURL }, text, async (page) => {
      const list = blocked(page);
      await expect(list.getByText("Marzo 2020", { exact: true })).toBeVisible();
      await expect(list).toContainText("Meta del mes · mes");
    });
  });

  // The template refuses a quantity on a goal with no measure at its own line, so only
  // a model's draft, kept in the tab, reaches the review with one.
  test("a commitment refused alone: the row names the commitment, not the goal", async ({ person, browser, baseURL }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      await toOpenSeededReview(
        page,
        seedOf([
          rawGoal("Meta del compromiso", {
            horizon: plus(200),
            commitments: [
              { name: "Correr lejos", cadenceKind: "daily", cadenceWeekdays: null, cadenceN: null, satisfaction: "quantity", targetQuantity: 5, unit: "km", src: [] },
            ],
          }),
        ]),
      );
      const list = blocked(page);
      await expect(list).toContainText("Correr lejos");
      await expect(list).toContainText("Meta del compromiso · compromiso");
    } finally {
      await context.close();
    }
  });
});
